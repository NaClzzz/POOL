import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiSuccess } from '@/contracts/domain'
import type { Page } from '@/contracts/music'
import type { CreateRoom, Room, RoomHistory } from '@/contracts/room'
import { useSession } from '@/stores/session'
import { http, HttpError } from '../http'
import { notifyError, notifySuccess } from '../notifications'
import type { MutationSuccessOptions } from './types'

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
  /** 历史详情包含房间资料，共享总结由独立接口读取。 */
  async historyDetail(roomId: string, signal?: AbortSignal) {
    return (
      await http.get<ApiSuccess<RoomHistory>>(`/room-history/${encodeURIComponent(roomId)}`, {
        signal,
      })
    ).data.data
  },
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
