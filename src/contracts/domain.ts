/** 标识平台身份，不随接口实现切换。 */
export type MusicSource = 'netease' | 'bilibili'

/** 在搜索、喜欢和房间中传递的统一歌曲资料。 */
export type Track = {
  source: MusicSource
  source_id: string
  title: string | null
  author: string | null
  album: string | null
  duration_ms: number | null
  cover_url: string | null
  extra: Record<string, unknown> | null
}

/** 收藏时保存的歌曲快照与添加时间。 */
export type LikedTrack = Track & { addedAt: string }
/** 大厅及归档使用的安全房间摘要。 */
export type Room = {
  roomId: string
  roomCode: string
  name: string
  tag: string
  ownerId: string
  ownerName: string
  memberCount: number
  maxMembers: number
  maxStageMembers: number
  isPasswordProtected: boolean
  cover: string
  createdBy: string
  status: 'active' | 'ended'
  endedAt: string | null
  expiresAt: string | null
}
/** 用户访问总结的历史凭证。 */
export type RoomHistory = { roomId: string; lastJoinedAt: string }
/** 房间共享总结的可恢复生成状态。 */
export type Summary = {
  status: 'notGenerated' | 'generating' | 'failed' | 'succeeded'
  content: string
  attemptId: string | null
}
/** 发送到房间界面的成员投影。 */
export type Member = { userId: string; name: string; color: string; isOwner: boolean }
/** 聊天展示消息，与确认回调分开。 */
export type ChatMessage = {
  id: string
  senderId: string
  senderName: string
  content: string
  createdAt: string
}
/** 当前房间的版本化节目和起播锚点。 */
export type Playback = {
  version: number
  track: Track | null
  activeMemberId: string | null
  startedAt: number
  votes: string[]
}
/** 房间页专用快照，离开页面即销毁。 */
export type RoomSnapshot = {
  room: Room
  members: Member[]
  stageIds: string[]
  messages: ChatMessage[]
  myPlaylist: Track[]
  playback: Playback
  connection: 'joined' | 'reconnecting'
}
/** 可复现的模拟接口场景。 */
export type DemoScenario = 'normal' | 'slow' | 'offline' | 'limited' | 'ai-fail'
/** 普通模拟接口的统一结果形状。 */
export type ApiResult<T> =
  | { ok: true; data: T; requestId: string }
  | { ok: false; error: { code: string; message: string }; requestId: string }
/** 模拟数据库：只保存业务资料，不保存密码和房间实时状态。 */
export type DemoDatabase = {
  messages: Record<string, ChatMessage[]>
  playedSongs: Record<string, Track[]>
  version: 1
  likes: Record<string, LikedTrack[]>
  playlists: Record<string, Track[]>
  history: Record<string, RoomHistory[]>
  rooms: Room[]
  summaries: Record<string, Summary>
  scenario: DemoScenario
}

/** 生成可跨音源比较的稳定条目身份。 */
export function trackKey(track: Pick<Track, 'source' | 'source_id'>) {
  return `${track.source}:${track.source_id}`
}
