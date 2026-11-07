import type { ChatMessage, Room, RoomSnapshot, Track } from '@/contracts/domain'
import { trackKey } from '@/contracts/domain'
import {
  ApiError,
  appendRoomMessage,
  endRoom,
  getDatabase,
  getRoomPlaylist,
  requireUser,
  recordRoomPlayback,
  saveRoomPlaylist,
  updateRoom,
} from './api'
import { catalog } from './fixtures'

/** 页内房间命令与订阅边界，后续替换为 Socket transport。 */
export class MockRoomSession {
  private snapshot: RoomSnapshot
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private listeners = new Set<(snapshot: RoomSnapshot) => void>()
  private messagesSent: number[] = []
  private disposed = false
  private turn = -1
  private playbackTimer: ReturnType<typeof setTimeout> | null = null
  private user = requireUser()

  constructor(room: Room) {
    const own = room.ownerId === this.user.id
    const members = own
      ? []
      : [
          { userId: room.ownerId, name: room.ownerName, color: 'teal', isOwner: true },
          {
            userId: room.ownerId === 'guest-lu' ? 'guest-chen' : 'guest-lu',
            name: '小鹿',
            color: 'peach',
            isOwner: false,
          },
        ].slice(0, room.maxMembers - 1)
    this.snapshot = {
      room: { ...room, memberCount: members.length + 1 },
      members: [
        ...members,
        { userId: this.user.id, name: this.user.name, color: 'blue', isOwner: own },
      ],
      stageIds: own ? [] : [room.ownerId],
      messages: own
        ? []
        : [
            {
              id: 'welcome',
              senderId: room.ownerId,
              senderName: room.ownerName,
              content: '来啦，欢迎把你喜欢的歌带上来 🌿',
              createdAt: new Date().toISOString(),
            },
          ],
      myPlaylist: getRoomPlaylist(this.user.id),
      playback: { version: 0, track: null, activeMemberId: null, startedAt: 0, votes: [] },
      connection: 'joined',
    }
    const savedMessages = getDatabase().messages[room.roomId]
    if (savedMessages) this.snapshot.messages = savedMessages.slice(-200)
    else for (const message of this.snapshot.messages) appendRoomMessage(room.roomId, message)
    if (!own) this.advance()
    else
      this.schedule(() => {
        this.snapshot.members.push({
          userId: 'guest-lu',
          name: '小鹿',
          color: 'peach',
          isOwner: false,
        })
        this.snapshot.room.memberCount = this.snapshot.members.length
        const message: ChatMessage = {
          id: 'guest-arrived',
          senderId: 'guest-lu',
          senderName: '小鹿',
          content: '带着一首喜欢的歌来啦，晚上好。',
          createdAt: new Date().toISOString(),
        }
        this.snapshot.messages.push(message)
        appendRoomMessage(room.roomId, message)
        this.emit()
      }, 2200)
  }

  /** 注册单个页面订阅；快照始终以新对象发送。 */
  subscribe(listener: (snapshot: RoomSnapshot) => void) {
    this.listeners.add(listener)
    listener(structuredClone(this.snapshot))
    return () => {
      this.listeners.delete(listener)
    }
  }
  /** 向仍挂载的房间界面发送当前投影。 */
  private emit() {
    if (!this.disposed)
      for (const listener of this.listeners) listener(structuredClone(this.snapshot))
  }
  /** 统一登记模拟事件计时器，以便离页完整取消。 */
  private schedule(callback: () => void, delay: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.disposed) callback()
    }, delay)
    this.timers.add(timer)
    return timer
  }
  /** 在线命令统一检查连接，重连时禁止修改。 */
  private assertConnected() {
    if (this.disposed || this.snapshot.connection !== 'joined')
      throw new ApiError('NOT_CONNECTED', '正在重新连接，请稍后操作', 409)
  }
  /** 房主管理只在活动房间内生效。 */
  private assertOwner() {
    this.assertConnected()
    if (this.snapshot.room.ownerId !== this.user.id)
      throw new ApiError('FORBIDDEN', '只有房主可以操作', 403)
  }

  /** 按固定上台顺序轮播；每次轮到本人时将首曲移到队尾。 */
  private advance() {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer)
      this.timers.delete(this.playbackTimer)
    }
    const stage = this.snapshot.stageIds
    let owner: string | null = null
    let track: Track | null = null
    for (let i = 0; i < stage.length; i++) {
      this.turn = (this.turn + 1) % stage.length
      const memberId = stage[this.turn]
      if (memberId === this.user.id && this.snapshot.myPlaylist.length) {
        owner = memberId
        track = this.snapshot.myPlaylist[0]
        this.snapshot.myPlaylist = [...this.snapshot.myPlaylist.slice(1), track]
        saveRoomPlaylist(this.user.id, this.snapshot.myPlaylist)
        break
      }
      if (memberId !== this.user.id) {
        owner = memberId
        track = catalog[(this.snapshot.playback.version + this.turn) % catalog.length]
        break
      }
    }
    this.snapshot.playback = {
      version: this.snapshot.playback.version + 1,
      track,
      activeMemberId: owner,
      startedAt: Date.now() + 500,
      votes: [],
    }
    if (track) {
      const version = this.snapshot.playback.version
      this.schedule(() => {
        if (this.snapshot.playback.version === version)
          recordRoomPlayback(this.snapshot.room.roomId, track!)
      }, 500)
    }
    if (track) this.playbackTimer = this.schedule(() => this.advance(), track.duration_ms! + 500)
    this.emit()
  }

  /** 上台与下台使用同一顺序队列，重复请求不重复加入。 */
  toggleStage() {
    this.assertConnected()
    const stages = this.snapshot.stageIds
    if (stages.includes(this.user.id)) {
      this.snapshot.stageIds = stages.filter((id) => id !== this.user.id)
      this.turn = this.snapshot.stageIds.indexOf(this.snapshot.playback.activeMemberId ?? '')
      if (this.snapshot.playback.activeMemberId === this.user.id) this.advance()
      else this.emit()
    } else {
      if (stages.length >= this.snapshot.room.maxStageMembers)
        throw new ApiError('STAGE_FULL', '上台人数已满', 409)
      if (!this.snapshot.myPlaylist.length)
        throw new ApiError('EMPTY_PLAYLIST', '先在我的歌单里添加歌曲')
      stages.push(this.user.id)
      if (!this.snapshot.playback.track) this.advance()
      else this.emit()
    }
  }
  /** 房主可让其他成员下台，本人也可主动下台。 */
  leaveStage(userId: string) {
    this.assertConnected()
    if (userId !== this.user.id && this.snapshot.room.ownerId !== this.user.id)
      throw new ApiError('FORBIDDEN', '只有房主可以让其他成员下台', 403)
    const index = this.snapshot.stageIds.indexOf(userId)
    if (index < 0) return
    this.snapshot.stageIds = this.snapshot.stageIds.filter((id) => id !== userId)
    if (this.snapshot.playback.activeMemberId === userId) {
      this.turn = index - 1
      this.advance()
    } else {
      this.turn = this.snapshot.stageIds.indexOf(this.snapshot.playback.activeMemberId ?? '')
      this.emit()
    }
  }
  /** 当前播放者直接切歌，其他用户每个节目只能投一次票。 */
  skip() {
    this.assertConnected()
    const p = this.snapshot.playback
    if (p.activeMemberId === this.user.id) {
      this.advance()
      return
    }
    if (p.votes.includes(this.user.id)) return
    p.votes.push(this.user.id)
    this.emit()
    const version = p.version
    this.schedule(() => {
      if (this.snapshot.playback.version !== version) return
      this.snapshot.playback.votes = this.snapshot.members
        .filter((m) => m.userId !== p.activeMemberId)
        .map((m) => m.userId)
      this.emit()
      this.schedule(() => this.advance(), 700)
    }, 1300)
  }
  /** 播放错误仅接受当前节目及当前播放者的上报。 */
  mediaError(version: number) {
    if (
      this.snapshot.playback.version === version &&
      this.snapshot.playback.activeMemberId === this.user.id
    )
      this.advance()
  }
  /** 添加个人房间歌单条目，按平台身份去重并限制容量。 */
  addTrack(track: Track) {
    this.assertConnected()
    if (this.snapshot.myPlaylist.some((t) => trackKey(t) === trackKey(track)))
      throw new ApiError('DUPLICATE_TRACK', '这首歌已经在你的房间歌单中')
    if (this.snapshot.myPlaylist.length >= 500)
      throw new ApiError('PLAYLIST_LIMIT_REACHED', '房间歌单最多 500 首', 409)
    this.snapshot.myPlaylist.push(track)
    this.savePlaylist()
  }
  /** 移除歌单条目，不改变已在播放的节目快照。 */
  removeTrack(track: Track) {
    this.assertConnected()
    this.snapshot.myPlaylist = this.snapshot.myPlaylist.filter(
      (t) => trackKey(t) !== trackKey(track),
    )
    this.savePlaylist()
  }
  /** 按歌曲身份移至目标位置，拖拽不修改当前节目与播放版本。 */
  moveTrack(track: Track, toIndex: number) {
    this.assertConnected()
    const list = this.snapshot.myPlaylist
    const index = list.findIndex((item) => trackKey(item) === trackKey(track))
    if (index < 0 || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= list.length)
      throw new ApiError('INVALID_INPUT', '歌单条目或目标位置无效')
    if (index === toIndex) return
    const [moved] = list.splice(index, 1)
    list.splice(toIndex, 0, moved)
    this.savePlaylist()
  }
  /** 支持清空、确定性打乱和导入喜欢，不超过上限。 */
  playlistAction(action: 'clear' | 'shuffle' | 'import') {
    this.assertConnected()
    if (action === 'clear') this.snapshot.myPlaylist = []
    if (action === 'shuffle')
      this.snapshot.myPlaylist = [
        ...this.snapshot.myPlaylist.filter((_, i) => i % 2),
        ...this.snapshot.myPlaylist.filter((_, i) => i % 2 === 0),
      ]
    if (action === 'import') {
      const seen = new Set(this.snapshot.myPlaylist.map(trackKey))
      for (const t of getDatabase().likes[this.user.id] ?? [])
        if (!seen.has(trackKey(t)) && this.snapshot.myPlaylist.length < 500) {
          this.snapshot.myPlaylist.push(t)
          seen.add(trackKey(t))
        }
    }
    this.savePlaylist()
  }
  /** 保存成员歌单并发布新快照。 */
  private savePlaylist() {
    saveRoomPlaylist(this.user.id, this.snapshot.myPlaylist)
    if (!this.snapshot.playback.track) this.advance()
    else this.emit()
  }
  /** 模拟聊天长度、用户频率和消息广播。 */
  send(content: string) {
    this.assertConnected()
    const value = content.trim()
    if (!value || Array.from(value).length > 120)
      throw new ApiError('INVALID_INPUT', '消息需要 1～120 个字符')
    this.messagesSent = this.messagesSent.filter((t) => Date.now() - t < 10_000)
    if (this.messagesSent.length >= 5)
      throw new ApiError('RATE_LIMITED', '发得有些快，稍等几秒再聊', 429)
    this.messagesSent.push(Date.now())
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      senderId: this.user.id,
      senderName: this.user.name,
      content: value,
      createdAt: new Date().toISOString(),
    }
    this.snapshot.messages = [...this.snapshot.messages, message].slice(-200)
    appendRoomMessage(this.snapshot.room.roomId, message)
    this.emit()
    const guest = this.snapshot.members.find((m) => m.userId !== this.user.id)
    if (guest)
      this.schedule(() => {
        const reply: ChatMessage = {
          id: crypto.randomUUID(),
          senderId: guest.userId,
          senderName: guest.name,
          content: '听见啦，这个时候一起听歌刚刚好。',
          createdAt: new Date().toISOString(),
        }
        this.snapshot.messages.push(reply)
        appendRoomMessage(this.snapshot.room.roomId, reply)
        this.snapshot.messages = this.snapshot.messages.slice(-200)
        this.emit()
      }, 1100)
  }
  /** 房主移除成员，同时修正上台和播放状态。 */
  kick(userId: string) {
    this.assertOwner()
    if (userId === this.user.id) return
    this.snapshot.members = this.snapshot.members.filter((m) => m.userId !== userId)
    this.snapshot.stageIds = this.snapshot.stageIds.filter((id) => id !== userId)
    this.snapshot.room.memberCount = this.snapshot.members.length
    if (this.snapshot.playback.activeMemberId === userId) this.advance()
    else this.emit()
  }
  /** 更新房间基本设置；密码不作为模拟数据保存。 */
  settings(input: {
    name: string
    tag: string
    maxMembers: number
    maxStageMembers: number
    isPasswordProtected: boolean
  }) {
    this.assertOwner()
    if (
      input.name.trim().length < 2 ||
      input.name.length > 20 ||
      input.tag.trim().length < 2 ||
      input.tag.length > 12
    )
      throw new ApiError('INVALID_INPUT', '房间名称 2～20 字符，标签 2～12 字符')
    if (
      !Number.isInteger(input.maxMembers) ||
      input.maxMembers < Math.max(2, this.snapshot.members.length) ||
      input.maxMembers > 50 ||
      !Number.isInteger(input.maxStageMembers) ||
      input.maxStageMembers < Math.max(1, this.snapshot.stageIds.length) ||
      input.maxStageMembers > Math.min(30, input.maxMembers)
    )
      throw new ApiError(
        'INVALID_INPUT',
        '人数不能小于当前成员或上台人数，且上台人数不能超过房间容量',
      )
    this.snapshot.room = {
      ...this.snapshot.room,
      name: input.name.trim(),
      tag: input.tag.trim(),
      maxMembers: input.maxMembers,
      maxStageMembers: input.maxStageMembers,
      isPasswordProtected: input.isPasswordProtected,
    }
    updateRoom(this.snapshot.room)
    this.emit()
  }
  /** 结束房间并保留归档资料。 */
  dissolve() {
    this.assertOwner()
    endRoom(this.snapshot.room.roomId)
    this.dispose()
  }
  /** 演示断线期间停用命令，重连时按当前锚点恢复。 */
  reconnect() {
    this.assertConnected()
    this.snapshot.connection = 'reconnecting'
    this.emit()
    this.schedule(() => {
      this.snapshot.connection = 'joined'
      this.emit()
    }, 1800)
  }
  /** 离页取消所有事件与轮播，不留下后台房间实例。 */
  dispose() {
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.listeners.clear()
    if (
      this.snapshot.room.ownerId === this.user.id &&
      getDatabase().rooms.some(
        (r) => r.roomId === this.snapshot.room.roomId && r.status === 'active',
      )
    ) {
      const next = this.snapshot.members.find((m) => m.userId !== this.user.id)
      if (next)
        updateRoom({
          ...this.snapshot.room,
          ownerId: next.userId,
          ownerName: next.name,
          memberCount: this.snapshot.members.length - 1,
        })
    }
  }
}
