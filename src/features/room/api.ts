import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiSuccess, Track } from '@/contracts/domain'
import type { Page } from '@/contracts/music'
import type {
  CreateRoom,
  Room,
  RoomHistory,
  RoomHistoryDetail,
  RoomImportResult,
  RoomPlaylistItem,
} from '@/contracts/room'
import { useSession } from '@/stores/session'
import { http, HttpError, type MutationSuccessOptions } from '@/lib/http'
import { notifyError, notifySuccess } from '@/lib/notifications'

/** 房间接口 */
export const roomsApi = {
  /** 获取房间列表 */
  list: async (q: string, signal?: AbortSignal) => {
    return (
      await http.get<ApiSuccess<{ rooms: Page<Room>; myRoom: Room | null }>>('/rooms', {
        params: { q, offset: 0, limit: 500 },
        signal,
      })
    ).data.data
  },
  /** 创建房间 */
  create: async (input: CreateRoom) => {
    return (await http.post<ApiSuccess<Room>>('/rooms', input)).data.data
  },
  /** 获取房间历史列表 */
  history: async (signal?: AbortSignal) => {
    return (
      await http.get<ApiSuccess<Page<RoomHistory>>>('/room-history', {
        params: { offset: 0, limit: 50 },
        signal,
      })
    ).data.data.items
  },
  /** 删除房间历史 */
  deleteHistory: async (roomId: string) => {
    return (await http.delete<ApiSuccess<null>>(`/room-history/${encodeURIComponent(roomId)}`)).data
      .data
  },
  /** 获取房间历史详情 */
  historyDetail: async (roomId: string, signal?: AbortSignal) => {
    return (
      await http.get<ApiSuccess<RoomHistoryDetail>>(`/room-history/${encodeURIComponent(roomId)}`, {
        signal,
      })
    ).data.data
  },
}

/** 个人房间歌单接口 */
export const roomPlaylistApi = {
  /** 获取本人房间歌单。 */
  list: async (signal?: AbortSignal) => {
    return (await http.get<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist', { signal })).data.data
  },
  /** 添加歌曲 */
  add: async (reference: {
    source: Track['source']
    source_id: string
    extra?: Track['extra']
  }) => {
    return (await http.post<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist', reference)).data.data
  },
  /** 移除歌曲 */
  remove: async (itemId: string) => {
    return (
      await http.delete<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist', { params: { itemId } })
    ).data.data
  },
  /** 调整歌曲顺序 */
  reorder: async (input: { itemId: string; toIndex: number }) => {
    return (await http.patch<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist', input)).data.data
  },
  /** 随机打乱房间歌单 */
  shuffle: async () => {
    return (await http.post<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist/shuffle')).data.data
  },
  /** 清空房间歌单 */
  clear: async () => {
    return (await http.delete<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist/clear')).data.data
  },
  /** 从服务端喜欢列表导入有效曲目 */
  importLiked: async () => {
    return (await http.post<ApiSuccess<RoomImportResult>>('/room-playlist/import-liked')).data.data
  },
}

/** 获取房间列表 */
export function useRooms(q: string) {
  const userId = useSession((s) => s.user?.id)
  return useQuery({
    queryKey: ['rooms', userId, q],
    queryFn: ({ signal }) => roomsApi.list(q, signal),
    enabled: !!userId,
    refetchInterval: 15_000,
  })
}

/** 创建房间 */
export function useCreateRoom(options: MutationSuccessOptions<Room, CreateRoom> = {}) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: roomsApi.create,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: async (room, input, userId) => {
      await client.invalidateQueries({ queryKey: ['rooms', userId] })
      if (userId !== useSession.getState().user?.id) return
      notifySuccess('房间已创建')
      await options.onSuccess?.(room, input)
    },
    onError: (error, _input, userId) => {
      if (error instanceof HttpError && error.code === 'INVALID_INPUT') return
      if (userId === useSession.getState().user?.id) notifyError(error)
    },
  })
}

/** 获取房间历史列表 */
export function useRoomHistory() {
  const userId = useSession((s) => s.user?.id)
  return useQuery({
    queryKey: ['room-history', userId],
    queryFn: ({ signal }) => roomsApi.history(signal),
    enabled: !!userId,
  })
}

/** 删除房间历史 */
export function useDeleteRoomHistory(options: MutationSuccessOptions<null, string> = {}) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: roomsApi.deleteHistory,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: async (data, roomId, userId) => {
      client.removeQueries({ queryKey: ['room-history-detail', userId, roomId] })
      client.removeQueries({ queryKey: ['room-summary', userId, roomId] })
      await client.invalidateQueries({ queryKey: ['room-history', userId] })
      if (userId !== useSession.getState().user?.id) return
      await options.onSuccess?.(data, roomId)
    },
    onError: (error, _roomId, userId) => {
      if (userId === useSession.getState().user?.id) notifyError(error)
    },
  })
}

/** 获取房间历史详情 */
export function useRoomHistoryDetail(roomId: string) {
  const userId = useSession((s) => s.user?.id)
  return useQuery({
    queryKey: ['room-history-detail', userId, roomId],
    queryFn: ({ signal }) => roomsApi.historyDetail(roomId, signal),
    enabled: !!userId,
  })
}

/** 个人房间歌单写操作 hooks */
export function useRoomPlaylistActions(onUpdated: (items: RoomPlaylistItem[]) => void) {
  const add = useMutation({
    mutationFn: roomPlaylistApi.add,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: (items, _ref, userId) => {
      if (userId !== useSession.getState().user?.id) return
      onUpdated(items)
    },
    onError: (error, _ref, userId) => {
      if (userId === useSession.getState().user?.id) notifyError(error)
    },
  })
  const remove = useMutation({
    mutationFn: roomPlaylistApi.remove,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: (items, _id, userId) => {
      if (userId !== useSession.getState().user?.id) return
      onUpdated(items)
    },
    onError: (error, _id, userId) => {
      if (userId === useSession.getState().user?.id) notifyError(error)
    },
  })
  const reorder = useMutation({
    mutationFn: roomPlaylistApi.reorder,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: (items, _input, userId) => {
      if (userId !== useSession.getState().user?.id) return
      onUpdated(items)
    },
    onError: (error, _input, userId) => {
      if (userId === useSession.getState().user?.id) notifyError(error)
    },
  })
  const shuffle = useMutation({
    mutationFn: roomPlaylistApi.shuffle,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: (items, _v, userId) => {
      if (userId !== useSession.getState().user?.id) return
      onUpdated(items)
    },
    onError: (error, _v, userId) => {
      if (userId === useSession.getState().user?.id) notifyError(error)
    },
  })
  const clear = useMutation({
    mutationFn: roomPlaylistApi.clear,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: (items, _v, userId) => {
      if (userId !== useSession.getState().user?.id) return
      onUpdated(items)
    },
    onError: (error, _v, userId) => {
      if (userId === useSession.getState().user?.id) notifyError(error)
    },
  })
  const importLiked = useMutation({
    mutationFn: roomPlaylistApi.importLiked,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: (result, _v, userId) => {
      if (userId !== useSession.getState().user?.id) return
      onUpdated(result.items)
      notifySuccess(
        `已加入 ${result.added} 首歌曲`,
        `重复 ${result.duplicates} 首 · 不支持或无时长 ${result.failed} 首 · 容量不足 ${result.capacitySkipped} 首`,
      )
    },
    onError: (error, _v, userId) => {
      if (userId === useSession.getState().user?.id) notifyError(error)
    },
  })
  return { add, remove, reorder, shuffle, clear, importLiked }
}
