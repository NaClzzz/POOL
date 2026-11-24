import { randomUUID } from 'node:crypto'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { KeyedSerial } from './keyed-serial'
import { BusinessError } from '../http/errors'
import type {
  RoomSnapshot,
  Member,
  RoomCommands,
  RoomCommandResult,
  RoomSettings,
} from '@/contracts/room'
import * as repo from './repository'
import { EMPTY_ROOM_MS, ARCHIVE_MS, isActiveRoom, recordRoomJoin } from './http-service'
import {
  idlePlayback,
  updateVotes,
  recordPlayed,
  advancePlayback,
  joinStage,
  removeStage,
  voteSkip,
  reportMediaError,
  type LiveRoom,
  type PlaybackDeps,
  type RoomUser,
} from './playback'

export type { RoomUser } from './playback'
export {
  EMPTY_ROOM_MS,
  ARCHIVE_MS,
  ROOM_HISTORY_LIMIT,
  createRoom,
  listRooms,
  recordRoomJoin,
  listHistory,
  deleteHistory,
  historyDetail,
} from './http-service'

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

/** 独立 Socket 服务持有的房间协调器，只负责在线成员、聊天、轮播与到期归档。 */
export class RoomService {
  private revision = 0
  private live = new Map<string, LiveRoom>()
  private userRooms = new Map<string, string>()
  private bindings = new Map<string, { userId: string; code: string }>()
  private serial = new KeyedSerial()
  private chatLimits = new Map<string, number[]>()
  private sweepTimer?: ReturnType<typeof setInterval>
  private readonly playbackDeps: PlaybackDeps

  /** 只注入传输层广播回调，不直接耦合 Socket.IO 实例或外部曲库。 */
  constructor(private readonly notify: (notice: RoomNotice) => void) {
    this.playbackDeps = {
      runRoomSerial: (roomCode, action) => this.serial.run([`1:room:${roomCode}`], action),
      broadcast: (live) => this.broadcast(live),
      playlistChanged: (userId) => this.playlistChanged(userId),
    }
  }

  /** 启动时丢弃在线投影，并保留原先为空房间的截止时间。 */
  async start() {
    await repo.resetOnlineState(new Date(Date.now() + EMPTY_ROOM_MS), (saved) =>
      idlePlayback(saved.roomId, saved.roomCode, saved.version + 1),
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
      playback: idlePlayback(row.id, code, saved?.playback.version ?? 0),
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
          if (event === 'room:join' || event === 'room:switch')
            return this.joinRoom(live, socketId, user, event, payload as RoomCommands['room:join'])
          this.assertMember(socketId, user.id, live)
          if (event === 'room:leave') {
            await this.leaveSocket(live, socketId, user.id)
            return { snapshot: null }
          }
          switch (event) {
            case 'room:sync':
              break
            case 'room:stage:join':
              await joinStage(live, user.id, this.playbackDeps)
              break
            case 'room:stage:leave': {
              const targetId = (payload as RoomCommands['room:stage:leave']).targetUserId ?? user.id
              if (targetId !== user.id) this.assertOwner(live, user.id)
              await removeStage(live, targetId, this.playbackDeps)
              break
            }
            case 'room:playlist:sync':
              await this.playlistChanged(user.id)
              if (live.playback.status === 'idle') await advancePlayback(live, this.playbackDeps)
              break
            case 'room:chat:send':
              await this.sendChat(live, user, (payload as RoomCommands['room:chat:send']).content)
              break
            case 'room:playback:skip':
              if (live.playback.activeMemberId !== user.id)
                throw new BusinessError('FORBIDDEN', '只有当前播放者可以直接切歌', 403)
              await advancePlayback(live, this.playbackDeps)
              break
            case 'room:playback:vote-skip':
              await voteSkip(live, user.id, this.playbackDeps)
              break
            case 'room:playback:media-error':
              await reportMediaError(
                live,
                user.id,
                payload as RoomCommands['room:playback:media-error'],
                this.playbackDeps,
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
          return { snapshot: await this.snapshot(live, user.id) }
        },
      )
    })
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
    updateVotes(live)
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
    const now = Date.now()
    const times = (this.chatLimits.get(user.id) ?? []).filter((t) => now - t < 10_000)
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
    await removeStage(live, userId, this.playbackDeps)
    updateVotes(live)
    if (
      live.playback.track &&
      live.playback.votes.length &&
      live.playback.votes.length >= live.playback.skipVoteRequired
    )
      await advancePlayback(live, this.playbackDeps)
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
    await recordPlayed(live.playback)
    const now = endedAt
    const playback = idlePlayback(live.row.id, live.row.code, live.playback.version + 1)
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
            playback: idlePlayback(current.id, current.code, 0),
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
