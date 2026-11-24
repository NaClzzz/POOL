import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiSuccess, Track, LikedTrack } from '@/contracts/domain'
import type { Page, ImportLikesResult, ImportPlaylistInput } from '@/contracts/music'
import { useSession } from '@/stores/session'
import { http, HttpError, type MutationSuccessOptions } from '@/lib/http'
import { notifyError, notifySuccess } from '@/lib/notifications'

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
  import: async (input: ImportPlaylistInput) => {
    const response = await http.post<ApiSuccess<ImportLikesResult>>('/likes/import', input)
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
      if (useSession.getState().user?.id !== userId) return
      notifySuccess(data.added ? '已加入喜欢' : '歌曲已在喜欢列表中')
      await options.onSuccess?.(data, track)
    },
    onError: (error, _track, userId) => {
      if (useSession.getState().user?.id === userId) notifyError(error)
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
      if (useSession.getState().user?.id !== userId) return
      notifySuccess('已取消喜欢')
      await options.onSuccess?.(data, track)
    },
    onError: (error, _track, userId) => {
      if (useSession.getState().user?.id === userId) notifyError(error)
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
      if (useSession.getState().user?.id !== userId) return
      notifySuccess('喜欢列表已清空')
      await options.onSuccess?.(data, variables)
    },
    onError: (error, _variables, userId) => {
      if (useSession.getState().user?.id === userId) notifyError(error)
    },
  })
}

/** 歌单链接导入 */
export function useImportLikes(
  options: MutationSuccessOptions<ImportLikesResult, ImportPlaylistInput> = {},
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: likesApi.import,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: async (data, input, userId) => {
      await client.invalidateQueries({ queryKey: ['likes', userId], exact: true })
      if (useSession.getState().user?.id !== userId) return
      notifySuccess(
        `已导入 ${data.added} 首歌曲`,
        `重复 ${data.duplicates} 首 · 失败 ${data.failed} 首 · 剩余容量 ${data.remainingCapacity} 首` +
          (data.capacitySkipped ? ` · 容量跳过 ${data.capacitySkipped} 首` : '') +
          (data.hasMore ? '；歌单还有未读取曲目' : ''),
      )
      await options.onSuccess?.(data, input)
    },
    onError: (error, _input, userId) => {
      if (
        error instanceof HttpError &&
        ['INVALID_INPUT', 'INVALID_PLAYLIST_LINK'].includes(error.code)
      )
        return
      if (useSession.getState().user?.id === userId) notifyError(error)
    },
  })
}
