import type { ApiResult, Track } from './domain'

/** 大厅、活动房与归档共用的安全资料，不包含密码摘要。 */
export type Room = {
  roomId: string
  roomCode: string
  name: string
  tag: string
  ownerId: string
  ownerName: string
  createdBy: string
  memberCount: number
  maxMembers: number
  maxStageMembers: number
  isPasswordProtected: boolean
  lastActiveAt: string
  status: 'active' | 'ended'
  endedAt: string | null
  expiresAt: string | null
}
/** 已成功加入房间的在线用户，同用户多连接只占一席。 */
export type Member = {
  userId: string
  name: string
  image: string | null
  joinedAt: string
  isOwner: boolean
}
/** 独立于喜欢和个人播放队列的用户房间歌单条目。 */
export type RoomPlaylistItem = { itemId: string; position: number; track: Track }
/** 版本化的权威时间轴；客户端不得通过媒体结束事件推进节目。 */
export type Playback = {
  roomId: string
  roomCode: string
  version: number
  status: 'idle' | 'playing'
  track: Track | null
  activeMemberId: string | null
  currentItemId: string | null
  startedAt: number | null
  startOffsetMs: number
  durationMs: number | null
  votes: string[]
  skipVoteRequired: number
}
/** 已提交的聊天消息；客户端以 ID 去重。 */
export type ChatMessage = {
  id: string
  roomId: string
  senderId: string
  senderName: string
  content: string
  createdAt: string
}
/** 加入、重连及命令超时校准返回的完整房间投影。 */
export type RoomSnapshot = {
  room: Room
  members: Member[]
  stageIds: string[]
  messages: ChatMessage[]
  myPlaylist: RoomPlaylistItem[]
  playback: Playback
  serverTime: number
  revision: number
}
/** 创建及设置共用的容量字段；密码修改必须表达明确意图。 */
export type CreateRoom = {
  name: string
  tag: string
  maxMembers: number
  maxStageMembers: number
  password?: string
}
/** 房主设置的密码保持、更新或移除操作。 */
export type RoomSettings = Omit<CreateRoom, 'password'> & {
  passwordAction: 'keep' | 'set' | 'remove'
  password?: string
}
/** 历史只代表本人访问凭证，不提供结束后的聊天查询。 */
export type RoomHistory = Room & { lastJoinedAt: string }
/** 导入反馈只统计实际检查过的收藏。 */
export type RoomImportResult = {
  items: RoomPlaylistItem[]
  added: number
  duplicates: number
  failed: number
  capacitySkipped: number
}
/** Socket 确认使用业务结果及可选重试等待时间，不携带 HTTP 状态。 */
export type RoomAck<T> = ApiResult<T> & { retryAfter?: number }
/** 命令名与参数集中定义，客户端和服务端共享。 */
export type RoomCommands = {
  'room:join': { roomCode: string; password?: string }
  'room:switch': { roomCode: string; password?: string }
  'room:sync': Record<string, never>
  'room:leave': Record<string, never>
  'room:stage:join': Record<string, never>
  'room:stage:leave': { targetUserId?: string }
  'room:playlist:add': { source: Track['source']; source_id: string; extra?: Track['extra'] }
  'room:playlist:remove': { itemId: string }
  'room:playlist:reorder': { itemId: string; toIndex: number }
  'room:playlist:shuffle': Record<string, never>
  'room:playlist:clear': Record<string, never>
  'room:playlist:import-liked': Record<string, never>
  'room:chat:send': { content: string }
  'room:playback:skip': Record<string, never>
  'room:playback:vote-skip': Record<string, never>
  'room:playback:media-error': { version: number; itemId: string }
  'room:update-settings': RoomSettings
  'room:kick-member': { targetUserId: string }
  'room:dissolve': Record<string, never>
}
/** 所有已加入命令返回快照，导入另带统计；避免维护第二套客户端乐观状态。 */
export type RoomCommandResult = {
  snapshot: RoomSnapshot | null
  imported?: Omit<RoomImportResult, 'items'>
}
/** Socket.IO 双端共享的事件签名。 */
export type ClientRoomEvents = {
  [K in keyof RoomCommands]: (
    payload: RoomCommands[K],
    ack: (result: RoomAck<RoomCommandResult>) => void,
  ) => void
}
/** 私有完整快照只发给对应用户，强退通知只影响指定房间。 */
export type ServerRoomEvents = {
  'room:state': (state: Omit<RoomSnapshot, 'myPlaylist' | 'messages'>) => void
  'room:message': (message: ChatMessage) => void
  'user:room-playlist': (items: RoomPlaylistItem[]) => void
  'room:forced-leave': (event: {
    roomCode: string
    reason: 'switched' | 'kicked' | 'dissolved' | 'session-expired'
  }) => void
}
