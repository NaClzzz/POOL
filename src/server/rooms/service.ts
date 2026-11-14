import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { and, eq, lt, isNull, sql } from 'drizzle-orm'
import { db } from '../db'
import { rooms, roomMembers, roomPlaybackStates } from '../db/rooms-schema'
import { BusinessError } from '../http/errors'
import { trackKey, type Track } from '@/contracts/domain'
import type {
  RoomSnapshot,
  Playback,
  Member,
  RoomCommands,
  RoomCommandResult,
  RoomSettings,
} from '@/contracts/room'
import * as repo from './repository'

/** 可信身份只从 Better Auth 会话取得。 */
export type RoomUser = { id: string; name: string; image?: string | null }
/** 同一用户多标签页合并为一个在线成员。 */
type OnlineMember = { user: RoomUser; joinedAt: Date; sockets: Set<string> }
/** 单实例房间权威状态；不把连接与定时器持久化。 */
type LiveRoom = {
  row: repo.RoomRow
  members: Map<string, OnlineMember>
  stage: string[]
  playback: Playback
  activeIndex: number
  timer?: ReturnType<typeof setTimeout>
  startTimer?: ReturnType<typeof setTimeout>
}
/** 广播只发送公共投影或对应用户的私有歌单，避免聊天携带五百首歌单。 */
export type RoomNotice =
  | { type: 'state'; roomCode: string; state: Omit<RoomSnapshot, 'myPlaylist' | 'messages'> }
  | { type: 'playlist'; userId: string; items: RoomSnapshot['myPlaylist'] }
  | { type: 'chat'; roomCode: string; message: RoomSnapshot['messages'][number] }
  | {
      type: 'leave'
      socketIds: string[]
      roomCode: string
      reason: 'switched' | 'kicked' | 'dissolved'
    }

/** 串行化相同键的异步操作，结束即释放键，不保留已完成请求。 */
export class KeyedSerial {
  private pending = new Map<string, Promise<unknown>>()
  async run<T>(keys: string[], action: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort()
    const run = (index: number): Promise<T> => {
      if (index === sorted.length) return action()
      const key = sorted[index]
      const previous = this.pending.get(key) ?? Promise.resolve()
      const next = previous.catch(() => undefined).then(() => run(index + 1))
      this.pending.set(key, next)
      void next
        .finally(() => {
          if (this.pending.get(key) === next) this.pending.delete(key)
        })
        .catch(() => undefined)
      return next
    }
    return run(0)
  }
  /** 退出前等待断开处理与在途数据库操作完成。 */
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending.values()])
  }
}

/** 独立 Socket 服务持有的房间协调器；曲库查询委托 Web 实例。 */
export class RoomService {
  private revision = 0
  private live = new Map<string, LiveRoom>()
  private userRooms = new Map<string, string>()
  private bindings = new Map<string, { userId: string; code: string }>()
  private serial = new KeyedSerial()
  private chatLimits = new Map<string, number[]>()
  private sweepTimer?: ReturnType<typeof setInterval>
  constructor(
    private readonly resolveTrack: (reference: RoomCommands['room:playlist:add']) => Promise<Track>,
    private readonly notify: (notice: RoomNotice) => void,
  ) {}

  /** 启动时丢弃在线投影，并保留原先为空房间的截止时间。 */
  async start() {
    await db.transaction(async (tx) => {
      await tx.update(roomMembers).set({ leftAt: new Date() }).where(isNull(roomMembers.leftAt))
      await tx
        .update(rooms)
        .set({ memberCount: 0, emptyExpiresAt: new Date(Date.now() + repo.EMPTY_ROOM_MS) })
        .where(and(eq(rooms.status, 'active'), sql`${rooms.memberCount} > 0`))
      const states = await tx.select().from(roomPlaybackStates)
      for (const state of states)
        await tx
          .update(roomPlaybackStates)
          .set({
            activeIndex: -1,
            playback: this.idle(
              state.playback.roomId,
              state.playback.roomCode,
              state.playback.version + 1,
            ),
          })
          .where(eq(roomPlaybackStates.roomId, state.roomId))
    })
    await this.sweep()
    this.sweepTimer = setInterval(
      () => void this.sweep().catch(() => console.error('[rooms] 到期清理失败')),
      60_000,
    )
  }
  /** 服务停止时取消全部后台任务，测试和进程退出共用。 */
  stop() {
    clearInterval(this.sweepTimer)
    for (const live of this.live.values()) {
      clearTimeout(live.timer)
      clearTimeout(live.startTimer)
    }
  }
  /** Socket 已停止接收后排空在途操作，再取消其可能新建的定时器。 */
  async drain() {
    await this.serial.drain()
    this.stop()
  }
  /** 空闲状态仍推进版本，使迟到的旧媒体报告失效。 */
  private idle(roomId: string, roomCode: string, version: number): Playback {
    return {
      roomId,
      roomCode,
      version,
      status: 'idle',
      track: null,
      activeMemberId: null,
      currentItemId: null,
      startedAt: null,
      startOffsetMs: 0,
      durationMs: null,
      votes: [],
      skipVoteRequired: 0,
    }
  }
  /** 按需加载房间；磁盘时间轴只用于保留递增版本。 */
  private async load(code: string) {
    let live = this.live.get(code)
    if (live) return live
    const row = await repo.findRoom(code)
    if (
      !row ||
      row.status !== 'active' ||
      (!row.memberCount && row.emptyExpiresAt.getTime() <= Date.now())
    )
      throw new BusinessError('ROOM_NOT_FOUND', '房间不存在或已结束', 404)
    const saved = (
      await db.select().from(roomPlaybackStates).where(eq(roomPlaybackStates.roomId, row.id))
    )[0]
    live = {
      row,
      members: new Map(),
      stage: [],
      playback: this.idle(row.id, code, saved?.playback.version ?? 0),
      activeIndex: -1,
    }
    this.live.set(code, live)
    return live
  }
  /** 公共投影不含私有歌单和消息。 */
  private async state(live: LiveRoom) {
    const members: Member[] = [...live.members.values()].map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      image: m.user.image ?? null,
      joinedAt: m.joinedAt.toISOString(),
      isOwner: m.user.id === live.row.ownerId,
    }))
    return {
      room: await repo.safeRoom(live.row),
      members,
      stageIds: [...live.stage],
      playback: { ...live.playback, votes: [...live.playback.votes] },
      serverTime: Date.now(),
      revision: ++this.revision,
    }
  }
  /** 加入及命令确认读取本人私有歌单。 */
  private async snapshot(live: LiveRoom, userId: string): Promise<RoomSnapshot> {
    const [state, myPlaylist, messages] = await Promise.all([
      this.state(live),
      repo.getPlaylist(userId),
      repo.recentMessages(live.row.id),
    ])
    return { ...state, myPlaylist, messages }
  }
  /** 活动身份必须绑定到当前连接，不能仅信任 userId。 */
  private assertMember(socketId: string, userId: string, live: LiveRoom) {
    if (!live.members.get(userId)?.sockets.has(socketId))
      throw new BusinessError('NOT_IN_ROOM', '请先加入房间', 409)
  }
  /** 房主权限随活动房间流转。 */
  private assertOwner(live: LiveRoom, userId: string) {
    if (live.row.ownerId !== userId) throw new BusinessError('FORBIDDEN', '只有房主可以操作', 403)
  }
  /** 已提交的公共状态广播给该房间全部连接。 */
  private async broadcast(live: LiveRoom) {
    this.notify({ type: 'state', roomCode: live.row.code, state: await this.state(live) })
  }
  /** 用户歌单更新发到该用户全部房间连接。 */
  private async playlistChanged(userId: string) {
    this.notify({ type: 'playlist', userId, items: await repo.getPlaylist(userId) })
  }

  /** 入口已校验参数；用户与涉及房间采用固定顺序协调，避免切换和离线交叉。 */
  async execute<K extends keyof RoomCommands>(
    socketId: string,
    user: RoomUser,
    event: K,
    payload: RoomCommands[K],
  ): Promise<RoomCommandResult> {
    return this.serial.run([`0:user:${user.id}`], async () => {
      const target =
        event === 'room:join' || event === 'room:switch'
          ? (payload as RoomCommands['room:join']).roomCode
          : this.bindings.get(socketId)?.code
      if (!target) {
        if (event === 'room:leave') return { snapshot: null }
        throw new BusinessError('NOT_IN_ROOM', '请先加入房间', 409)
      }
      const oldCode = this.userRooms.get(user.id)
      return this.serial.run(
        [`1:room:${target}`, ...(oldCode ? [`1:room:${oldCode}`] : [])],
        async () => {
          const live = await this.load(target)
          if (event === 'room:join' || event === 'room:switch') {
            const currentCode = this.userRooms.get(user.id)
            if (currentCode && currentCode !== target && event !== 'room:switch')
              throw new BusinessError('ALREADY_IN_ROOM', '你已在其他房间，是否切换到此房间？', 409)
            await repo.checkPassword(live.row, (payload as RoomCommands['room:join']).password)
            const existing = live.members.get(user.id)
            if (!existing && live.members.size >= live.row.maxMembers)
              throw new BusinessError('ROOM_FULL', '房间人数已满', 409)
            if (currentCode && currentCode !== target) {
              const old = this.live.get(currentCode)!
              const sockets = [...old.members.get(user.id)!.sockets]
              await this.removeUser(old, user.id)
              this.notify({
                type: 'leave',
                roomCode: currentCode,
                socketIds: sockets,
                reason: 'switched',
              })
            }
            const member = existing ?? { user, joinedAt: new Date(), sockets: new Set<string>() }
            await repo.recordJoin(
              live.row,
              user.id,
              live.members.size + (existing ? 0 : 1),
              member.joinedAt,
            )
            member.user = user
            member.sockets.add(socketId)
            live.members.set(user.id, member)
            live.row.memberCount = live.members.size
            live.row.lastActiveAt = new Date()
            this.bindings.set(socketId, { userId: user.id, code: target })
            this.userRooms.set(user.id, target)
            this.updateVotes(live)
            await this.broadcast(live)
            return { snapshot: await this.snapshot(live, user.id) }
          }
          this.assertMember(socketId, user.id, live)
          if (event === 'room:leave') {
            await this.leaveSocket(live, socketId, user.id)
            return { snapshot: null }
          }
          let imported: RoomCommandResult['imported']
          if (event === 'room:stage:join') {
            if (!live.stage.includes(user.id)) {
              if (live.stage.length >= live.row.maxStageMembers)
                throw new BusinessError('STAGE_FULL', '上台人数已满', 409)
              live.stage.push(user.id)
              if (live.playback.status === 'idle') await this.advance(live)
            }
          } else if (event === 'room:stage:leave') {
            const targetId = (payload as RoomCommands['room:stage:leave']).targetUserId ?? user.id
            if (targetId !== user.id) this.assertOwner(live, user.id)
            await this.removeStage(live, targetId)
          } else if (event.startsWith('room:playlist:')) {
            imported = await this.playlistCommand(live, user.id, event, payload)
          } else if (event === 'room:chat:send') {
            const now = Date.now(),
              times = (this.chatLimits.get(user.id) ?? []).filter((t) => now - t < 10_000)
            if (times.length >= 5)
              throw new BusinessError(
                'RATE_LIMITED',
                '聊天过于频繁，请稍后再发',
                429,
                Math.max(1, Math.ceil((times[0] + 10_000 - now) / 1000)),
              )
            times.push(now)
            this.chatLimits.set(user.id, times)
            const message = {
              id: randomUUID(),
              roomId: live.row.id,
              senderId: user.id,
              senderName: user.name,
              content: (payload as RoomCommands['room:chat:send']).content,
              createdAt: new Date().toISOString(),
            }
            await repo.appendMessage(message)
            this.notify({ type: 'chat', roomCode: target, message })
          } else if (event === 'room:playback:skip') {
            if (live.playback.activeMemberId !== user.id)
              throw new BusinessError('FORBIDDEN', '只有当前播放者可以直接切歌', 403)
            await this.advance(live)
          } else if (event === 'room:playback:vote-skip') {
            if (!live.playback.track || live.playback.activeMemberId === user.id)
              throw new BusinessError('FORBIDDEN', '当前不能投票', 403)
            if (!live.playback.votes.includes(user.id)) live.playback.votes.push(user.id)
            this.updateVotes(live)
            if (live.playback.votes.length >= live.playback.skipVoteRequired)
              await this.advance(live)
          } else if (event === 'room:playback:media-error') {
            const report = payload as RoomCommands['room:playback:media-error']
            if (
              live.playback.activeMemberId === user.id &&
              live.playback.version === report.version &&
              live.playback.currentItemId === report.itemId
            )
              await this.advance(live)
          } else if (event === 'room:update-settings') {
            this.assertOwner(live, user.id)
            const settings = payload as RoomSettings
            if (
              settings.maxMembers < live.members.size ||
              settings.maxStageMembers < live.stage.length
            )
              throw new BusinessError('ROOM_CAPACITY_CONFLICT', '人数上限不能小于当前人数', 409)
            const passwordHash =
              settings.passwordAction === 'keep'
                ? live.row.passwordHash
                : settings.passwordAction === 'remove'
                  ? null
                  : await hashPassword(settings.password!)
            const [row] = await db
              .update(rooms)
              .set({
                name: settings.name,
                tag: settings.tag,
                maxMembers: settings.maxMembers,
                maxStageMembers: settings.maxStageMembers,
                passwordHash,
                lastActiveAt: new Date(),
              })
              .where(eq(rooms.id, live.row.id))
              .returning()
            live.row = row
          } else if (event === 'room:kick-member') {
            this.assertOwner(live, user.id)
            const targetId = (payload as RoomCommands['room:kick-member']).targetUserId
            if (targetId === user.id) throw new BusinessError('INVALID_INPUT', '不能移出自己', 400)
            const sockets = [...(live.members.get(targetId)?.sockets ?? [])]
            await this.removeUser(live, targetId)
            this.notify({ type: 'leave', roomCode: target, socketIds: sockets, reason: 'kicked' })
          } else if (event === 'room:dissolve') {
            this.assertOwner(live, user.id)
            await this.end(live)
            return { snapshot: null }
          }
          await this.broadcast(live)
          return { snapshot: await this.snapshot(live, user.id), ...(imported ? { imported } : {}) }
        },
      )
    })
  }

  /** 私有歌单命令以服务端规范资料和持久收藏为输入。 */
  private async playlistCommand<K extends keyof RoomCommands>(
    live: LiveRoom,
    userId: string,
    event: K,
    payload: RoomCommands[K],
  ) {
    let track: Track | undefined
    if (event === 'room:playlist:add') {
      track = await this.resolveTrack(payload as RoomCommands['room:playlist:add'])
      if (track.source !== 'netease' || !track.duration_ms || track.duration_ms <= 0)
        throw new BusinessError(
          'TRACK_DURATION_REQUIRED',
          '该歌曲缺少有效时长，不能加入房间歌单',
          409,
        )
    }
    const likes = event === 'room:playlist:import-liked' ? await repo.likedTracks(userId) : []
    const stats = { added: 0, duplicates: 0, failed: 0, capacitySkipped: 0 }
    await repo.editPlaylist(userId, (items) => {
      if (track) {
        if (items.some((i) => trackKey(i.track) === trackKey(track!)))
          throw new BusinessError('TRACK_ALREADY_ADDED', '歌曲已在房间歌单中', 409)
        return [{ itemId: randomUUID(), position: 0, track }, ...items]
      }
      if (event === 'room:playlist:clear') return []
      if (event === 'room:playlist:shuffle') {
        for (let i = items.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[items[i], items[j]] = [items[j], items[i]]
        }
      } else if (event === 'room:playlist:remove' || event === 'room:playlist:reorder') {
        const input = payload as RoomCommands['room:playlist:reorder']
        const index = items.findIndex((i) => i.itemId === input.itemId)
        if (index < 0) throw new BusinessError('ITEM_NOT_FOUND', '歌单条目不存在', 404)
        const [item] = items.splice(index, 1)
        if (event === 'room:playlist:reorder') {
          if (input.toIndex > items.length)
            throw new BusinessError('INVALID_INPUT', '排序位置无效', 400)
          items.splice(input.toIndex, 0, item)
        }
      } else if (event === 'room:playlist:import-liked') {
        const seen = new Set(items.map((i) => trackKey(i.track)))
        for (const liked of likes) {
          if (seen.has(trackKey(liked))) {
            stats.duplicates++
            continue
          }
          if (liked.source !== 'netease' || !liked.duration_ms || liked.duration_ms <= 0) {
            stats.failed++
            continue
          }
          if (items.length >= 500) {
            stats.capacitySkipped++
            continue
          }
          const { source, source_id, title, author, album, duration_ms, cover_url, extra } = liked
          items.push({
            itemId: randomUUID(),
            position: items.length,
            track: { source, source_id, title, author, album, duration_ms, cover_url, extra },
          })
          seen.add(trackKey(liked))
          stats.added++
        }
      }
      return items
    })
    await this.playlistChanged(userId)
    if (live.playback.status === 'idle') await this.advance(live)
    return event === 'room:playlist:import-liked' ? stats : undefined
  }
  /** 以现有在线成员重新计算票数，离线用户的票不继续占位。 */
  private updateVotes(live: LiveRoom) {
    const eligible = [...live.members.keys()].filter((id) => id !== live.playback.activeMemberId)
    live.playback.votes = live.playback.votes.filter((id) => eligible.includes(id))
    live.playback.skipVoteRequired = live.playback.track ? eligible.length : 0
  }
  /** 自然结束、切歌和错误都走同一推进路径，一次最多扫描一轮上台成员。 */
  private async advance(live: LiveRoom, from = live.activeIndex) {
    clearTimeout(live.timer)
    clearTimeout(live.startTimer)
    await repo.recordPlayed(live.playback)
    let next = this.idle(live.row.id, live.row.code, live.playback.version + 1),
      activeIndex = -1
    for (let step = 1; step <= live.stage.length; step++) {
      const index = (from + step + live.stage.length) % live.stage.length
      const userId = live.stage[index]
      const items = await repo.getPlaylist(userId)
      const item = items.find(
        (i) => i.track.source === 'netease' && !!i.track.duration_ms && i.track.duration_ms > 0,
      )
      if (!item) continue
      await repo.editPlaylist(userId, (current) => {
        const at = current.findIndex((i) => i.itemId === item.itemId)
        const [head] = current.splice(at, 1)
        current.push(head)
        return current
      })
      next = {
        ...next,
        status: 'playing',
        track: item.track,
        activeMemberId: userId,
        currentItemId: item.itemId,
        startedAt: Date.now() + 4000,
        durationMs: item.track.duration_ms,
      }
      activeIndex = index
      await this.playlistChanged(userId)
      break
    }
    await repo.savePlayback(next, activeIndex)
    live.playback = next
    live.activeIndex = activeIndex
    this.updateVotes(live)
    if (next.status === 'playing') {
      const version = next.version
      live.startTimer = setTimeout(
        () =>
          void this.serial
            .run([`1:room:${live.row.code}`], async () => {
              if (live.playback.version === version) await repo.recordPlayed(next)
            })
            .catch(() => console.error('[rooms] 播放记录写入失败')),
        Math.max(0, next.startedAt! - Date.now()),
      )
      live.timer = setTimeout(
        () =>
          void this.serial
            .run([`1:room:${live.row.code}`], async () => {
              if (live.playback.version !== version) return
              await this.advance(live)
              await this.broadcast(live)
            })
            .catch(() => console.error('[rooms] 轮播推进失败')),
        Math.max(0, next.startedAt! + next.durationMs! - Date.now()),
      )
    }
  }
  /** 下台调整游标，当前播放者下台后立即轮到其后继。 */
  private async removeStage(live: LiveRoom, userId: string) {
    const index = live.stage.indexOf(userId)
    if (index < 0) return
    const current = live.playback.activeMemberId === userId
    live.stage.splice(index, 1)
    if (index <= live.activeIndex) live.activeIndex--
    if (current) await this.advance(live)
  }
  /** 移除用户全部连接，同时更新在线投影和房主。 */
  private async removeUser(live: LiveRoom, userId: string) {
    const member = live.members.get(userId)
    if (!member) return
    const nextOwner =
      live.row.ownerId === userId
        ? ([...live.members.keys()].find((id) => id !== userId) ?? userId)
        : live.row.ownerId
    const now = new Date()
    await db.transaction(async (tx) => {
      await tx
        .update(roomMembers)
        .set({ leftAt: now })
        .where(and(eq(roomMembers.roomId, live.row.id), eq(roomMembers.userId, userId)))
      await tx
        .update(rooms)
        .set({
          memberCount: live.members.size - 1,
          ownerId: nextOwner,
          lastActiveAt: now,
          ...(live.members.size === 1
            ? { emptyExpiresAt: new Date(now.getTime() + repo.EMPTY_ROOM_MS) }
            : {}),
        })
        .where(eq(rooms.id, live.row.id))
    })
    for (const id of member.sockets) this.bindings.delete(id)
    live.members.delete(userId)
    this.userRooms.delete(userId)
    live.row = (await repo.findRoom(live.row.code))!
    await this.removeStage(live, userId)
    this.updateVotes(live)
    if (
      live.playback.track &&
      live.playback.votes.length &&
      live.playback.votes.length >= live.playback.skipVoteRequired
    )
      await this.advance(live)
    await this.broadcast(live)
  }
  /** 单个标签页离开只删除自己的连接。 */
  private async leaveSocket(live: LiveRoom, socketId: string, userId: string) {
    const member = live.members.get(userId)
    if (!member) return
    if (member.sockets.size === 1) await this.removeUser(live, userId)
    else {
      member.sockets.delete(socketId)
      this.bindings.delete(socketId)
    }
  }
  /** 断开和显式离开共用逻辑，重复调用不会重复推进。 */
  async disconnect(socketId: string) {
    const binding = this.bindings.get(socketId)
    if (!binding) return
    await this.serial.run([`0:user:${binding.userId}`], () =>
      this.serial.run([`1:room:${binding.code}`], async () => {
        const live = this.live.get(binding.code)
        if (live) await this.leaveSocket(live, socketId, binding.userId)
      }),
    )
  }
  /** 结束归档先持久化，再清理内存和通知所有连接。 */
  private async end(live: LiveRoom, endedAt = new Date()) {
    await repo.recordPlayed(live.playback)
    const now = endedAt,
      playback = this.idle(live.row.id, live.row.code, live.playback.version + 1)
    await db.transaction(async (tx) => {
      await tx
        .update(rooms)
        .set({
          status: 'ended',
          memberCount: 0,
          endedAt: now,
          expiresAt: new Date(now.getTime() + repo.ARCHIVE_MS),
        })
        .where(eq(rooms.id, live.row.id))
      await tx.update(roomMembers).set({ leftAt: now }).where(eq(roomMembers.roomId, live.row.id))
      await tx
        .insert(roomPlaybackStates)
        .values({ roomId: live.row.id, playback, activeIndex: -1 })
        .onConflictDoUpdate({
          target: roomPlaybackStates.roomId,
          set: { playback, activeIndex: -1 },
        })
    })
    clearTimeout(live.timer)
    clearTimeout(live.startTimer)
    const socketIds = [...live.members.values()].flatMap((m) => [...m.sockets])
    for (const id of live.members.keys()) this.userRooms.delete(id)
    for (const id of socketIds) this.bindings.delete(id)
    this.live.delete(live.row.code)
    this.notify({ type: 'leave', roomCode: live.row.code, socketIds, reason: 'dissolved' })
  }
  /** 创建后一直无人加入的房间也参与到期归档。 */
  async sweep() {
    const expired = await db
      .select()
      .from(rooms)
      .where(
        and(
          eq(rooms.status, 'active'),
          eq(rooms.memberCount, 0),
          lt(rooms.emptyExpiresAt, new Date()),
        ),
      )
    for (const row of expired)
      await this.serial.run([`1:room:${row.code}`], async () => {
        const current = await repo.findRoom(row.code)
        if (
          !current ||
          current.status !== 'active' ||
          current.memberCount ||
          current.emptyExpiresAt.getTime() > Date.now()
        )
          return
        await this.end(
          this.live.get(row.code) ?? {
            row: current,
            members: new Map(),
            stage: [],
            playback: this.idle(current.id, current.code, 0),
            activeIndex: -1,
          },
          current.emptyExpiresAt,
        )
      })
    await db.delete(rooms).where(and(eq(rooms.status, 'ended'), lt(rooms.expiresAt, new Date())))
    for (const [id, times] of this.chatLimits)
      if (times.every((t) => Date.now() - t >= 10_000)) this.chatLimits.delete(id)
  }
}
