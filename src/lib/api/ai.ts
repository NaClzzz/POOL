import { useQuery } from '@tanstack/react-query'
import type { ApiSuccess } from '@/contracts/domain'
import type { RoomSummaryDto } from '@/contracts/ai'
import { useSession } from '@/stores/session'
import { http } from '../http'

/** 持久总结状态使用普通 Axios；模型生成流走 AI SDK 的独立传输。 */
export const aiApi = {
  async summary(roomId: string, signal?: AbortSignal) {
    return (
      await http.get<ApiSuccess<RoomSummaryDto>>(`/rooms/${encodeURIComponent(roomId)}/summary`, {
        signal,
      })
    ).data.data
  },
}

/** 仅在生成中每两秒查询；其他参与者不重新调用模型。 */
export function useRoomSummary(roomId: string, enabled = true, receiving = false) {
  const userId = useSession((s) => s.user?.id)
  return useQuery({
    queryKey: ['room-summary', userId, roomId],
    queryFn: ({ signal }) => aiApi.summary(roomId, signal),
    enabled: !!userId && enabled,
    refetchInterval: (query) =>
      receiving || query.state.data?.status === 'generating' ? 2000 : false,
    retry: false,
  })
}
