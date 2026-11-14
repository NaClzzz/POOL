import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiSuccess, Track, LikedTrack, MusicSource } from '@/contracts/domain'
import type { Page, ImportLikesResult, PlaybackResource, Lyrics } from '@/contracts/music'
import { useSession } from '@/stores/session'
import { http } from './http'
import type { CreateRoom, Room, RoomHistory } from '@/contracts/room'

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

/** 喜欢接口 */
export const likesApi = {
  /** 一次读取最多 500 首，保证搜索喜欢态不依赖已加载分页。 */
  list: async (signal?: AbortSignal) => {
    const response = await http.get<ApiSuccess<Page<LikedTrack>>>('/likes', {
      params: { offset: 0, limit: 500 },
      signal,
    })
    return response.data.data.items
  },
  /** 新增收藏，由 Axios 自动序列化 JSON 对象。 */
  add: async (track: Track) => {
    const response = await http.post<ApiSuccess<{ item: LikedTrack; added: boolean }>>('/likes', {
      track,
    })
    return response.data.data
  },
  /** 按歌曲身份幂等取消收藏。 */
  remove: async (track: Track) => {
    const response = await http.delete<ApiSuccess<null>>('/likes', {
      params: { source: track.source, id: track.source_id },
    })
    return response.data.data
  },
  /** 清空当前用户的喜欢列表。 */
  clear: async () => {
    const response = await http.delete<ApiSuccess<null>>('/likes/clear')
    return response.data.data
  },
  /** 导入链接交给服务端解析及容量检查。 */
  import: async (url: string) => {
    const response = await http.post<ApiSuccess<ImportLikesResult>>('/likes/import', {
      source: 'netease',
      url,
    })
    return response.data.data
  },
}

/** 房间 HTTP 只承载大厅、创建与本人历史，不维护实时快照。 */
export const roomsApi = {
  /** 大厅查询 */
  async list(q: string, signal?: AbortSignal) {
    return (
      await http.get<ApiSuccess<{ rooms: Page<Room>; myRoom: Room | null }>>('/rooms', {
        params: { q, offset: 0, limit: 500 },
        signal,
      })
    ).data.data
  },
  /** 创建房间 */
  async create(input: CreateRoom) {
    return (await http.post<ApiSuccess<Room>>('/rooms', input)).data.data
  },
  /** 读取当前账号最多五十条有效历史。 */
  async history(signal?: AbortSignal) {
    return (
      await http.get<ApiSuccess<Page<RoomHistory>>>('/room-history', {
        params: { offset: 0, limit: 50 },
        signal,
      })
    ).data.data.items
  },
  /** 删除本人访问凭证。 */
  async deleteHistory(roomId: string) {
    return (await http.delete<ApiSuccess<null>>(`/room-history/${encodeURIComponent(roomId)}`)).data
      .data
  },
  /** 历史详情只包含房间资料，AI 总结尚未接入。 */
  async historyDetail(roomId: string, signal?: AbortSignal) {
    return (
      await http.get<ApiSuccess<RoomHistory>>(`/room-history/${encodeURIComponent(roomId)}`, {
        signal,
      })
    ).data.data
  },
}

/** 业务 hooks ---------- */

/** 页面可追加成功后的界面动作，公共缓存刷新始终由对应 hook 先执行。 */
type LikeSuccessOptions<TData, TVariables = void> = {
  onSuccess?: (data: TData, variables: TVariables) => void | Promise<void>
}

/** 喜欢查询 */
export function useLikes({ enabled = true }: { enabled?: boolean } = {}) {
  const userId = useSession((state) => state.user?.id)
  return useQuery({
    queryKey: ['likes', userId],
    queryFn: ({ signal }) => likesApi.list(signal),
    enabled: !!userId && enabled,
  })
}

/** 新增喜欢 */
export function useAddLike(
  options: LikeSuccessOptions<Awaited<ReturnType<typeof likesApi.add>>, Track> = {},
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: likesApi.add,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: async (data, track, userId) => {
      await client.invalidateQueries({ queryKey: ['likes', userId], exact: true })
      if (useSession.getState().user?.id === userId) await options.onSuccess?.(data, track)
    },
  })
}

/** 取消喜欢 */
export function useRemoveLike(options: LikeSuccessOptions<null, Track> = {}) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: likesApi.remove,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: async (data, track, userId) => {
      await client.invalidateQueries({ queryKey: ['likes', userId], exact: true })
      if (useSession.getState().user?.id === userId) await options.onSuccess?.(data, track)
    },
  })
}

/** 清空喜欢 */
export function useClearLikes(options: LikeSuccessOptions<null> = {}) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => likesApi.clear(),
    onMutate: () => useSession.getState().user?.id,
    onSuccess: async (data, variables, userId) => {
      await client.invalidateQueries({ queryKey: ['likes', userId], exact: true })
      if (useSession.getState().user?.id === userId) await options.onSuccess?.(data, variables)
    },
  })
}

/** 歌单链接导入 */
export function useImportLikes(options: LikeSuccessOptions<ImportLikesResult, string> = {}) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: likesApi.import,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: async (data, url, userId) => {
      await client.invalidateQueries({ queryKey: ['likes', userId], exact: true })
      if (useSession.getState().user?.id === userId) await options.onSuccess?.(data, url)
    },
  })
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

/** 房间 hooks ---------- */

/** 大厅按账号隔离，每十五秒刷新安全摘要。 */
export function useRooms(q: string) {
  const userId = useSession((s) => s.user?.id)
  return useQuery({
    queryKey: ['rooms', userId, q],
    queryFn: ({ signal }) => roomsApi.list(q, signal),
    enabled: !!userId,
    refetchInterval: 15_000,
  })
}
/** 创建成功统一刷新大厅，页面负责导航和关闭表单。 */
export function useCreateRoom(options: LikeSuccessOptions<Room, CreateRoom> = {}) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: roomsApi.create,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: async (room, input, userId) => {
      await client.invalidateQueries({ queryKey: ['rooms', userId] })
      if (userId === useSession.getState().user?.id) await options.onSuccess?.(room, input)
    },
  })
}
/** 房间历史不依赖房间页实时 store。 */
export function useRoomHistory() {
  const userId = useSession((s) => s.user?.id)
  return useQuery({
    queryKey: ['room-history', userId],
    queryFn: ({ signal }) => roomsApi.history(signal),
    enabled: !!userId,
  })
}
/** 历史删除后清除对应详情缓存并更新列表。 */
export function useDeleteRoomHistory(options: LikeSuccessOptions<null, string> = {}) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: roomsApi.deleteHistory,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: async (data, roomId, userId) => {
      client.removeQueries({ queryKey: ['room-history-detail', userId, roomId] })
      await client.invalidateQueries({ queryKey: ['room-history', userId] })
      if (userId === useSession.getState().user?.id) await options.onSuccess?.(data, roomId)
    },
  })
}
/** 详情错误由页面呈现，权限由 HTTP 入口校验。 */
export function useRoomHistoryDetail(roomId: string) {
  const userId = useSession((s) => s.user?.id)
  return useQuery({
    queryKey: ['room-history-detail', userId, roomId],
    queryFn: ({ signal }) => roomsApi.historyDetail(roomId, signal),
    enabled: !!userId,
  })
}
