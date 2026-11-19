import { randomBytes, randomUUID } from 'node:crypto'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import axios from 'axios'
import { z } from 'zod'
import { readServerEnv } from '../env'
import { trackSchema } from '../music/validation'
import { KeyedSerial } from './keyed-serial'
import { BusinessError } from '../http/errors'
import { trackKey, type Track } from '@/contracts/domain'
import type {
  RoomSnapshot,
  Playback,
  Member,
  RoomCommands,
  RoomCommandResult,
  RoomSettings,
  CreateRoom,
  RoomHistory,
  RoomHistoryDetail,
} from '@/contracts/room'
import * as repo from './repository'

/** 空房与归档的业务保留期限。 */
/** 每人保留最近五十条成功加入凭证。 */
export const EMPTY_ROOM_MS = 30 * 60_000
export const ARCHIVE_MS = 7 * 24 * 60 * 60_000
export const ROOM_HISTORY_LIMIT = 50

/** 房间活动状态只在 Service 判定，Repository 负责按条件读写。 */
function isActiveRoom(row: repo.RoomRow, now = Date.now()) {
  return row.status === 'active' && (row.memberCount > 0 || row.emptyExpiresAt.getTime() > now)
}

/** 创建时在用户事务锁内判断已有有效房间，密码原文不进入 Repository。 */
export async function createRoom(userId: string, input: CreateRoom) {
  const passwordHash = input.password ? await hashPassword(input.password) : null
  const row = await repo.createRoom(
    {
      id: randomUUID(),
      code: `pool-${randomBytes(8).toString('hex')}`,
      ownerId: userId,
      createdBy: userId,
      name: input.name,
      tag: input.tag,
      maxMembers: input.maxMembers,
      maxStageMembers: input.maxStageMembers,
      passwordHash,
      emptyExpiresAt: new Date(Date.now() + EMPTY_ROOM_MS),
    },
    (owned) => {
      if (owned.some((room) => isActiveRoom(room)))
        throw new BusinessError('ROOM_ALREADY_CREATED', '你已有有效房间，请进入我的房间', 409)
    },
  )
  return repo.safeRoom(row)
}

/** 大厅只读取有效活动房间，分页和公开房筛选由 Repository 转成查询。 */
export function listRooms(userId: string, q: string, offset: number, limit: number) {
  return repo.listRooms(userId, q, offset, limit, {
    status: 'active',
    minMemberCount: 1,
    emptyExpiresAfter: new Date(),
    publicOnly: true,
  })
}

/** 成功加入后在同一用户事务内应用历史淘汰规则。 */
export function recordRoomJoin(row: repo.RoomRow, userId: string, count: number, joinedAt: Date) {
  return repo.recordJoin(row, userId, count, joinedAt, (ids) => ids.slice(ROOM_HISTORY_LIMIT))
}
/** 有效历史不依赖当前房主或在线成员身份。 */
export async function listHistory(userId: string): Promise<RoomHistory[]> {
  const rows = await repo.listHistory(userId)
  const now = Date.now()
  return rows
    .filter(({ room }) => !room.expiresAt || room.expiresAt.getTime() > now)
    .map(({ room, name, joined }) => ({
      ...repo.roomDto(room, name),
      lastJoinedAt: joined.toISOString(),
    }))
}

/** 删除只撤销本人凭证，与新增历史复用 Repository 的用户事务锁。 */
export function deleteHistory(userId: string, roomId: string) {
  return repo.deleteHistory(userId, roomId)
}

/** 详情要求本人仍持有有效凭证，权限错误在业务层产生。 */
export async function historyDetail(userId: string, roomId: string): Promise<RoomHistoryDetail> {
  const row = (await listHistory(userId)).find((item) => item.roomId === roomId)
  if (!row) throw new BusinessError('ROOM_HISTORY_REQUIRED', '房间已到期或没有访问记录', 403)
  return { ...row, ...(await repo.historyActivity(roomId)) }
}

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

/** 独立 Socket 服务持有的房间协调器；曲库查询委托 Web 实例。 */
export class RoomService {
  private revision = 0
  private live = new Map<string, LiveRoom>()
  private userRooms = new Map<string, string>()
  private bindings = new Map<string, { userId: string; code: string }>()
  private serial = new KeyedSerial()
  private chatLimits = new Map<string, number[]>()
  private sweepTimer?: ReturnType<typeof setInterval>
  private readonly upstream

  /** 房间业务自行持有 Web 曲库客户端，Socket 只注入传输通知。 */
  constructor(private readonly notify: (notice: RoomNotice) => void) {
    const config = z
      .object({
        ROOM_INTERNAL_SECRET: z.string().min(32),
        ROOM_WEB_URL: z.url().optional(),
      })
      .parse(process.env)
    this.upstream = axios.create({
      baseURL: config.ROOM_WEB_URL ?? readServerEnv().BETTER_AUTH_URL,
      proxy: false,
      timeout: 16_000,
      responseType: 'json',
      transitional: { silentJSONParsing: false },
      headers: { 'x-pool-room-secret': config.ROOM_INTERNAL_SECRET },
      validateStatus: () => true,
    })
  }

  /** 通过 Web 内部音乐入口获取权威资料，外部缓存和预算仍只由 Web 维护。 */
  private async resolveTrack(reference: RoomCommands['room:playlist:add']): Promise<Track> {
    const response = await this.upstream.post('/api/internal/room-track', reference)
    if (!response.data?.ok)
      throw new BusinessError(
        response.data?.error?.code ?? 'UPSTREAM_UNAVAILABLE',
        response.data?.error?.message ?? '音乐服务暂时不可用',
        response.status >= 400 ? response.status : 502,
      )
    return trackSchema.parse(response.data.data)
  }

  /** 启动时丢弃在线投影，并保留原先为空房间的截止时间。 */
  async start() {
    await repo.resetOnlineState(new Date(Date.now() + EMPTY_ROOM_MS), (saved) =>
      this.idle(saved.roomId, saved.roomCode, saved.version + 1),
    )
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
    if (!row || !isActiveRoom(row))
      throw new BusinessError('ROOM_NOT_FOUND', '房间不存在或已结束', 404)
    const saved = await repo.getPlayback(row.id)
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
          // 事件判定
          if (event === 'room:join' || event === 'room:switch')
            return this.joinRoom(live, socketId, user, event, payload as RoomCommands['room:join'])
          this.assertMember(socketId, user.id, live)
          if (event === 'room:leave') {
            await this.leaveSocket(live, socketId, user.id)
            return { snapshot: null }
          }
          let imported: RoomCommandResult['imported']
          switch (event) {
            case 'room:sync':
              break
            case 'room:stage:join':
              await this.joinStage(live, user.id)
              break
            case 'room:stage:leave':
              await this.leaveStage(live, user.id, payload as RoomCommands['room:stage:leave'])
              break
            case 'room:playlist:add':
            case 'room:playlist:remove':
            case 'room:playlist:reorder':
            case 'room:playlist:shuffle':
            case 'room:playlist:clear':
            case 'room:playlist:import-liked':
              imported = await this.playlistCommand(live, user.id, event, payload)
              break
            case 'room:chat:send':
              await this.sendChat(live, user, (payload as RoomCommands['room:chat:send']).content)
              break
            case 'room:playback:skip':
              if (live.playback.activeMemberId !== user.id)
                throw new BusinessError('FORBIDDEN', '只有当前播放者可以直接切歌', 403)
              await this.advance(live)
              break
            case 'room:playback:vote-skip':
              await this.voteSkip(live, user.id)
              break
            case 'room:playback:media-error':
              await this.reportMediaError(
                live,
                user.id,
                payload as RoomCommands['room:playback:media-error'],
              )
              break
            case 'room:update-settings':
              await this.updateSettings(live, user.id, payload as RoomSettings)
              break
            case 'room:kick-member':
              await this.kickMember(
                live,
                user.id,
                (payload as RoomCommands['room:kick-member']).targetUserId,
              )
              break
            case 'room:dissolve':
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

  /** 上台后仅在等待状态启动轮播，不打断当前节目。 */
  private async joinStage(live: LiveRoom, userId: string) {
    if (live.stage.includes(userId)) return
    if (live.stage.length >= live.row.maxStageMembers)
      throw new BusinessError('STAGE_FULL', '上台人数已满', 409)
    live.stage.push(userId)
    if (live.playback.status === 'idle') await this.advance(live)
  }

  /** 成员可自行下台，房主也可将其他成员移下台。 */
  private async leaveStage(
    live: LiveRoom,
    userId: string,
    input: RoomCommands['room:stage:leave'],
  ) {
    const targetId = input.targetUserId ?? userId
    if (targetId !== userId) this.assertOwner(live, userId)
    await this.removeStage(live, targetId)
  }

  /** 非播放者每人计一票，达到实时人数门槛后推进节目。 */
  private async voteSkip(live: LiveRoom, userId: string) {
    if (!live.playback.track || live.playback.activeMemberId === userId)
      throw new BusinessError('FORBIDDEN', '当前不能投票', 403)
    if (!live.playback.votes.includes(userId)) live.playback.votes.push(userId)
    this.updateVotes(live)
    if (live.playback.votes.length >= live.playback.skipVoteRequired) await this.advance(live)
  }

  /** 仅当前播放者对当前版本和条目的失败报告能推进房间。 */
  private async reportMediaError(
    live: LiveRoom,
    userId: string,
    report: RoomCommands['room:playback:media-error'],
  ) {
    if (
      live.playback.activeMemberId === userId &&
      live.playback.version === report.version &&
      live.playback.currentItemId === report.itemId
    )
      await this.advance(live)
  }

  /** 密码与目标容量验证成功后才从旧房间切换，并记录成功加入历史。 */
  private async joinRoom(
    live: LiveRoom,
    socketId: string,
    user: RoomUser,
    event: 'room:join' | 'room:switch',
    payload: RoomCommands['room:join'],
  ): Promise<RoomCommandResult> {
    const currentCode = this.userRooms.get(user.id)
    if (currentCode && currentCode !== live.row.code && event !== 'room:switch')
      throw new BusinessError('ALREADY_IN_ROOM', '你已在其他房间，是否切换到此房间？', 409)
    await this.checkPassword(live.row, payload.password)
    const existing = live.members.get(user.id)
    if (!existing && live.members.size >= live.row.maxMembers)
      throw new BusinessError('ROOM_FULL', '房间人数已满', 409)
    if (currentCode && currentCode !== live.row.code) {
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
    await recordRoomJoin(live.row, user.id, live.members.size + (existing ? 0 : 1), member.joinedAt)
    member.user = user
    member.sockets.add(socketId)
    live.members.set(user.id, member)
    live.row.memberCount = live.members.size
    live.row.lastActiveAt = new Date()
    this.bindings.set(socketId, { userId: user.id, code: live.row.code })
    this.userRooms.set(user.id, live.row.code)
    this.updateVotes(live)
    await this.broadcast(live)
    return { snapshot: await this.snapshot(live, user.id) }
  }

  /** 房间密码检查只在 Service 执行，不向数据层传递密码原文。 */
  private async checkPassword(row: repo.RoomRow, password?: string) {
    if (
      row.passwordHash &&
      (!password || !(await verifyPassword({ hash: row.passwordHash, password })))
    )
      throw new BusinessError(
        'ROOM_PASSWORD_REQUIRED',
        password ? '房间密码不正确' : '请输入房间密码',
        403,
      )
  }

  /** 应用聊天频率限制，消息落库成功后才通知传输层广播。 */
  private async sendChat(live: LiveRoom, user: RoomUser, content: string) {
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
      content,
      createdAt: new Date().toISOString(),
    }
    await repo.appendMessage(message)
    this.notify({ type: 'chat', roomCode: live.row.code, message })
  }

  /** 房主设置先校验实时容量，再保存已处理的密码哈希。 */
  private async updateSettings(live: LiveRoom, userId: string, settings: RoomSettings) {
    this.assertOwner(live, userId)
    if (settings.maxMembers < live.members.size || settings.maxStageMembers < live.stage.length)
      throw new BusinessError('ROOM_CAPACITY_CONFLICT', '人数上限不能小于当前人数', 409)
    const passwordHash =
      settings.passwordAction === 'keep'
        ? live.row.passwordHash
        : settings.passwordAction === 'remove'
          ? null
          : await hashPassword(settings.password!)
    live.row = await repo.updateRoom(live.row.id, {
      name: settings.name,
      tag: settings.tag,
      maxMembers: settings.maxMembers,
      maxStageMembers: settings.maxStageMembers,
      passwordHash,
      lastActiveAt: new Date(),
    })
  }

  /** 房主移出成员后统一清理连接，并通过 notice 通知 Socket 退出。 */
  private async kickMember(live: LiveRoom, userId: string, targetId: string) {
    this.assertOwner(live, userId)
    if (targetId === userId) throw new BusinessError('INVALID_INPUT', '不能移出自己', 400)
    const sockets = [...(live.members.get(targetId)?.sockets ?? [])]
    await this.removeUser(live, targetId)
    this.notify({ type: 'leave', roomCode: live.row.code, socketIds: sockets, reason: 'kicked' })
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
        if (items.length >= 500)
          throw new BusinessError('PLAYLIST_LIMIT_REACHED', '房间歌单最多 500 首', 409)
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

  /** 只持久化已经到达起播锚点的有效节目，不记录预加载。 */
  private async recordPlayed(playback: Playback) {
    if (
      !playback.track ||
      !playback.activeMemberId ||
      !playback.startedAt ||
      playback.startedAt > Date.now()
    )
      return
    await repo.recordPlayed(playback)
  }

  /** 自然结束、切歌和错误都走同一推进路径，一次最多扫描一轮上台成员。 */
  private async advance(live: LiveRoom, from = live.activeIndex) {
    clearTimeout(live.timer)
    clearTimeout(live.startTimer)
    await this.recordPlayed(live.playback)
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
              if (live.playback.version === version) await this.recordPlayed(next)
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
    const row = await repo.recordLeave(live.row.id, userId, now, {
      memberCount: live.members.size - 1,
      ownerId: nextOwner,
      lastActiveAt: now,
      ...(live.members.size === 1
        ? { emptyExpiresAt: new Date(now.getTime() + EMPTY_ROOM_MS) }
        : {}),
    })
    for (const id of member.sockets) this.bindings.delete(id)
    live.members.delete(userId)
    this.userRooms.delete(userId)
    live.row = row
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
    await this.recordPlayed(live.playback)
    const now = endedAt,
      playback = this.idle(live.row.id, live.row.code, live.playback.version + 1)
    await repo.archiveRoom(live.row.id, now, new Date(now.getTime() + ARCHIVE_MS), playback)
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
    const expired = await repo.findEmptyRoomsBefore(new Date())
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
    await repo.deleteArchivesBefore(new Date())
    for (const [id, times] of this.chatLimits)
      if (times.every((t) => Date.now() - t >= 10_000)) this.chatLimits.delete(id)
  }
}
