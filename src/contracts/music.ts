import type { Track } from './domain'

/** 各数据源共用的 offset 分页，未知总数与后续页状态允许为空。 */
export type Page<T> = {
  items: T[]
  offset: number
  limit: number
  total: number | null
  hasMore: boolean | null
}
/** 一次播放的临时资源，不写入收藏或数据库。 */
export type PlaybackResource = {
  url: string
  delivery: 'direct' | 'proxy'
  mime_type: string | null
  expires_at: string | null
  duration_ms: number | null
}
/** 无歌词使用 null，区别于上游请求失败。 */
export type Lyrics = { lrc: string | null; translationLrc: string | null }
/** 获取歌单与本次读取的页。 */
export type PlaylistTracks = {
  playlist: {
    source: Track['source']
    source_id: string
    title: string | null
    cover_url: string | null
  }
  tracks: Page<Track>
}
/** 导入请求只提交平台身份和歌单链接，平台引用由适配器解析。 */
export type ImportPlaylistInput = { source: Track['source']; url: string }

/** 仅反馈已处理的导入结果，未读取的剩余数量允许未知。 */
export type ImportLikesResult = {
  added: number
  duplicates: number
  failed: number
  capacitySkipped: number | null
  remainingCapacity: number
  hasMore: boolean
}
