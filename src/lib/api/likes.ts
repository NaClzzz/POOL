import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiSuccess, Track, LikedTrack } from '@/contracts/domain'
import type { Page, ImportLikesResult } from '@/contracts/music'
import { useSession } from '@/stores/session'
import { http } from '../http'
import type { MutationSuccessOptions } from './types'

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
  options: MutationSuccessOptions<Awaited<ReturnType<typeof likesApi.add>>, Track> = {},
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
export function useRemoveLike(options: MutationSuccessOptions<null, Track> = {}) {
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
export function useClearLikes(options: MutationSuccessOptions<null> = {}) {
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
export function useImportLikes(options: MutationSuccessOptions<ImportLikesResult, string> = {}) {
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
