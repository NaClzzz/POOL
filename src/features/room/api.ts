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

/** 房间 HTTP 承载大厅、创建、本人历史及个人房间歌单管理。 */
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
  /** 历史详情包含房间资料、参与者与互动计数，总结由独立接口读取。 */
  async historyDetail(roomId: string, signal?: AbortSignal) {
    return (
      await http.get<ApiSuccess<RoomHistoryDetail>>(`/room-history/${encodeURIComponent(roomId)}`, {
        signal,
      })
    ).data.data
  },
}

/** 个人房间歌单 HTTP 接口；写操作直接由 Web 进程校验并落库。 */
export const roomPlaylistApi = {
  /** 读取本人房间歌单。 */
  async list(signal?: AbortSignal) {
    return (await http.get<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist', { signal })).data.data
  },
  /** 传入曲目引用，由服务端获取权威时长后置顶加入。 */
  async add(reference: { source: Track['source']; source_id: string; extra?: Track['extra'] }) {
    return (await http.post<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist', reference)).data.data
  },
  /** 按 itemId 移除条目。 */
  async remove(itemId: string) {
    return (
      await http.delete<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist', { params: { itemId } })
    ).data.data
  },
  /** 调整条目顺序。 */
  async reorder(input: { itemId: string; toIndex: number }) {
    return (await http.patch<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist', input)).data.data
  },
  /** 随机打乱房间歌单。 */
  async shuffle() {
    return (await http.post<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist/shuffle')).data.data
  },
  /** 清空房间歌单。 */
  async clear() {
    return (await http.delete<ApiSuccess<RoomPlaylistItem[]>>('/room-playlist/clear')).data.data
  },
  /** 从服务端喜欢列表导入有效曲目。 */
  async importLiked() {
    return (await http.post<ApiSuccess<RoomImportResult>>('/room-playlist/import-liked')).data.data
  },
}

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

/** 房间历史不依赖房间页实时连接。 */
export function useRoomHistory() {
  const userId = useSession((s) => s.user?.id)
  return useQuery({
    queryKey: ['room-history', userId],
    queryFn: ({ signal }) => roomsApi.history(signal),
    enabled: !!userId,
  })
}

/** 历史删除后清除对应详情缓存并更新列表。 */
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
      notifySuccess('已删除这条房间历史')
      await options.onSuccess?.(data, roomId)
    },
    onError: (error, _roomId, userId) => {
      if (userId === useSession.getState().user?.id) notifyError(error)
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

/** 个人房间歌单写操作 hooks，成功后通知房间会话同步其他标签页及空闲轮播。 */
export function useRoomPlaylistActions(onUpdated: (items: RoomPlaylistItem[]) => void) {
  const add = useMutation({
    mutationFn: roomPlaylistApi.add,
    onMutate: () => useSession.getState().user?.id,
    onSuccess: (items, _ref, userId) => {
      if (userId !== useSession.getState().user?.id) return
      onUpdated(items)
      notifySuccess('已加入房间歌单')
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
      notifySuccess('已移除歌曲')
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
      notifySuccess('歌单顺序已更新')
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
      notifySuccess('歌单已打乱')
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
      notifySuccess('房间歌单已清空')
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
