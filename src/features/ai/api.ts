'use client'
import { useCompletion } from '@ai-sdk/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { z } from 'zod'
import type { ApiSuccess } from '@/contracts/domain'
import type { RoomSummaryDto } from '@/contracts/ai'
import { useSession } from '@/stores/session'
import { authClient } from '@/lib/auth-client'
import { http, HttpError } from '@/lib/http'
import { notifyError, notifySuccess } from '@/lib/notifications'

/** 持久总结状态使用普通 Axios；模型生成流走 AI SDK 的独立传输。 */
export const aiApi = {
  summary: async (roomId: string, signal?: AbortSignal) => {
    return (
      await http.get<ApiSuccess<RoomSummaryDto>>(`/rooms/${encodeURIComponent(roomId)}/summary`, {
        signal,
      })
    ).data.data
  },
}

/** 查询共享总结；仅在非本机接收 SSE 且服务端生成中时轮询持久状态。 */
export function useRoomSummary(roomId: string, receiving = false) {
  const userId = useSession((s) => s.user?.id)
  return useQuery({
    queryKey: ['room-summary', userId, roomId],
    queryFn: ({ signal }) => aiApi.summary(roomId, signal),
    enabled: !!userId,
    refetchInterval: (query) =>
      !receiving && query.state.data?.status === 'generating' ? 2000 : false,
    retry: false,
  })
}

/** 流开始前的 JSON 错误保持普通业务外壳，不交给 SSE 解析器。 */
const streamFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
})

/** useCompletion 只发送触发动作；校验非 2xx JSON 业务错误，SSE 原样交给 SDK 解析。 */
const completionFetch: typeof fetch = async (input, init) => {
  let response: Response
  try {
    response = await fetch(input, { ...init, body: '{}' })
  } catch (error) {
    if (init?.signal?.aborted) throw error
    throw new HttpError('NETWORK_ERROR', '无法连接生成服务，请检查网络后手动重试', 0, null)
  }
  if (response.status === 401) void authClient.getSession()
  const contentType = response.headers.get('Content-Type') ?? ''
  if (response.ok && response.body && contentType.includes('text/event-stream')) return response
  if (contentType.includes('application/json')) {
    const raw: unknown = await response.json().catch((error) => {
      if (init?.signal?.aborted) throw error
      return null
    })
    const failure = streamFailureSchema.safeParse(raw)
    if (failure.success)
      throw new HttpError(
        failure.data.error.code,
        failure.data.error.message,
        response.status,
        Number(response.headers.get('Retry-After')) || null,
      )
  }
  throw new HttpError(
    'INVALID_RESPONSE',
    '生成服务返回的数据格式异常，请手动重试',
    response.status,
    null,
  )
}

/** SDK 管理房间总结流；结束后以数据库持久状态确认结果，离页仅停止接收。 */
export function useRoomSummaryGeneration(roomId: string) {
  const client = useQueryClient()
  const userId = useSession((s) => s.user?.id)
  const api = `/api/rooms/${encodeURIComponent(roomId)}/summary`
  const instanceId = useId()
  const id = `${userId}:${api}:${instanceId}`
  const requestId = useRef(0)
  const [requestedId, setRequestedId] = useState<string>()
  const streamError = useRef<Error | null>(null)
  const { completion, isLoading, error, complete, stop, setCompletion } = useCompletion({
    id,
    api,
    streamProtocol: 'data',
    throttle: 50,
    fetch: completionFetch,
    onError: (failure) => {
      streamError.current = failure
    },
  })

  useEffect(
    () => () => {
      requestId.current++
      stop()
      setCompletion('')
    },
    [id, stop, setCompletion],
  )

  /** 流结束后刷新持久状态；由数据库最终状态决定成功、失败或交回轮询。 */
  const generate = () => {
    if (isLoading) return
    const currentRequest = ++requestId.current
    streamError.current = null
    setRequestedId(id)
    void complete('').then(async (text) => {
      const queryKey = ['room-summary', userId, roomId] as const
      if (requestId.current !== currentRequest) {
        void client.invalidateQueries({ queryKey })
        return
      }
      const saved = await client
        .fetchQuery({
          queryKey,
          queryFn: ({ signal }) => aiApi.summary(roomId, signal),
          staleTime: 0,
        })
        .catch(() => {
          void client.invalidateQueries({ queryKey })
          return null
        })
      if (requestId.current !== currentRequest) return
      if (saved?.status === 'succeeded') {
        if (text?.trim()) notifySuccess('房间总结已生成')
      } else if (streamError.current) {
        notifyError(streamError.current)
      } else if (saved?.status === 'failed') {
        notifyError(
          new HttpError(
            saved.errorCode ?? 'AI_INCOMPLETE',
            '生成未完整结束，请手动重试',
            502,
            null,
          ),
        )
      }
    })
  }

  return {
    text: completion,
    pending: isLoading,
    error: requestedId === id ? error : undefined,
    generate,
  }
}
