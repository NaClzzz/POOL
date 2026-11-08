import type { ApiResult, Track, LikedTrack, MusicSource } from '@/contracts/domain'
import type { Page, ImportLikesResult, PlaybackResource, Lyrics } from '@/contracts/music'
import { authClient } from './auth-client'

/** 业务客户端保留服务端错误分类和限流等待时间，认证仍走原生协议。 */
export class HttpError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public retryAfter: number | null,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 普通 JSON 在统一传输层解包；会话失效触发认证同步，缓存不跨账号复用。 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    credentials: 'same-origin',
    cache: 'no-store',
  })
  const result = (await response.json()) as ApiResult<T>
  if (!result.ok) {
    if (response.status === 401) void authClient.getSession()
    throw new HttpError(
      result.error.code,
      result.error.message,
      response.status,
      Number(response.headers.get('Retry-After')) || null,
    )
  }
  return result.data
}

/** 页面与播放器共用的真实 POOL 音乐入口，不直接请求网易云服务。 */
export const musicApi = {
  search: (source: MusicSource, q: string, offset = 0, limit = 30, signal?: AbortSignal) =>
    request<Page<Track>>(
      `/api/music/search?${new URLSearchParams({ source, q, offset: String(offset), limit: String(limit) })}`,
      { signal },
    ),
  getTrack: (source: MusicSource, id: string, signal?: AbortSignal) =>
    request<Track>(`/api/music/track?${new URLSearchParams({ source, id })}`, { signal }),
  lyrics: (source: MusicSource, id: string, signal?: AbortSignal) =>
    request<Lyrics>(`/api/music/lyrics?${new URLSearchParams({ source, id })}`, { signal }),
  playback: (track: Track, signal?: AbortSignal) =>
    request<PlaybackResource>('/api/music/playback', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        source: track.source,
        source_id: track.source_id,
        extra: track.extra,
      }),
    }),
}

/** 收藏总容量为 500，界面一次读取完整集合以保证搜索喜欢态不依赖分页。 */
export const likesApi = {
  list: (signal?: AbortSignal) =>
    request<Page<LikedTrack>>('/api/likes?offset=0&limit=500', { signal }).then(
      (page) => page.items,
    ),
  add: (track: Track) =>
    request<{ item: LikedTrack; added: boolean }>('/api/likes', {
      method: 'POST',
      body: JSON.stringify({ track }),
    }),
  remove: (track: Track) =>
    request<null>(
      `/api/likes?${new URLSearchParams({ source: track.source, id: track.source_id })}`,
      { method: 'DELETE' },
    ),
  clear: () => request<null>('/api/likes/clear', { method: 'DELETE' }),
  import: (url: string) =>
    request<ImportLikesResult>('/api/likes/import', {
      method: 'POST',
      body: JSON.stringify({ source: 'netease', url }),
    }),
}
