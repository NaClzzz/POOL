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
/** 普通业务成功响应，Axios 接口方法据此取得准确的业务数据类型。 */
export type ApiSuccess<T> = { ok: true; data: T; requestId: string }

/** 普通业务接口共用的统一结果形状。 */
export type ApiResult<T> =
  | ApiSuccess<T>
  | { ok: false; error: { code: string; message: string }; requestId: string }
/** 生成可跨音源比较的稳定条目身份。 */
export function trackKey(track: Pick<Track, 'source' | 'source_id'>) {
  return `${track.source}:${track.source_id}`
}
