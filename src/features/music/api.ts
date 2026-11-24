import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ApiSuccess, Track, MusicSource } from '@/contracts/domain'
import type { Page, PlaybackResource, Lyrics } from '@/contracts/music'
import { useSession } from '@/stores/session'
import { http } from '@/lib/http'

/** 音乐接口 */
export const musicApi = {
  /** 搜索结果使用统一分页，查询编码及取消交给 Axios。 */
  search: async (source: MusicSource, q: string, offset = 0, limit = 30, signal?: AbortSignal) => {
    const response = await http.get<ApiSuccess<Page<Track>>>('/music/search', {
      params: { source, q, offset, limit },
      signal,
    })
    return response.data.data
  },
  /** 按平台身份读取统一曲目详情。 */
  getTrack: async (source: MusicSource, id: string, signal?: AbortSignal) => {
    const response = await http.get<ApiSuccess<Track>>('/music/track', {
      params: { source, id },
      signal,
    })
    return response.data.data
  },
  /** 歌词按需读取，无歌词由服务端以 null 表达。 */
  lyrics: async (source: MusicSource, id: string, signal?: AbortSignal) => {
    const response = await http.get<ApiSuccess<Lyrics>>('/music/lyrics', {
      params: { source, id },
      signal,
    })
    return response.data.data
  },
  /** 只提交歌曲引用，播放地址不持久化。 */
  playback: async (track: Track, signal?: AbortSignal) => {
    const response = await http.post<ApiSuccess<PlaybackResource>>(
      '/music/playback',
      { source: track.source, source_id: track.source_id, extra: track.extra },
      { signal },
    )
    return response.data.data
  },
}

/** 音乐搜索 */
export function useMusicSearch(source: MusicSource, keyword: string) {
  const userId = useSession((state) => state.user?.id)
  const q = keyword.trim()
  return useInfiniteQuery({
    queryKey: ['music', 'search', source, q],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) => musicApi.search(source, q, pageParam, 30, signal),
    getNextPageParam: (page) => (page.hasMore ? page.offset + page.limit : undefined),
    enabled: !!userId && !!q,
  })
}

/** 歌词搜索 */
export function useLyrics(track: Track | null) {
  return useQuery({
    queryKey: ['music', 'lyrics', track?.source, track?.source_id],
    queryFn: ({ signal }) => musicApi.lyrics(track!.source, track!.source_id, signal),
    enabled: !!track,
    staleTime: 60_000,
  })
}
