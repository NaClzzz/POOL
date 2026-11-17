'use client'
import { useCompletion } from '@ai-sdk/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { JsonToSseTransformStream, parseJsonEventStream, uiMessageChunkSchema } from 'ai'
import { useEffect, useId, useRef, useState } from 'react'
import { z } from 'zod'
import type { ApiSuccess } from '@/contracts/domain'
import type { RoomSummaryDto } from '@/contracts/ai'
import { useSession } from '@/stores/session'
import { usePlaylistAnalysis } from '@/stores/playlist-analysis'
import { authClient } from '../auth-client'
import { http, HttpError } from '../http'

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

/** 歌单分析 hook */
export function usePlaylistAnalysisGeneration() {
  const userId = useSession((s) => s.user?.id)

  // 本地持久化
  const saved = usePlaylistAnalysis((s) => (userId ? s.results[userId] : undefined))
  const save = usePlaylistAnalysis((s) => s.save)

  const generation = useAiGeneration('/api/ai/liked-playlist-analysis', {
    onSuccess: (text) => {
      if (userId) save(userId, text)
    },
  })
  useEffect(() => {
    void usePlaylistAnalysis.persist.rehydrate()
  }, [])
  return { ...generation, text: generation.text || saved || '' }
}

/** 房间总结生成 hook */
export function useRoomSummaryGeneration(roomId: string) {
  const client = useQueryClient()
  const userId = useSession((s) => s.user?.id)
  return useAiGeneration(`/api/rooms/${encodeURIComponent(roomId)}/summary`, {
    onSettled: () => void client.invalidateQueries({ queryKey: ['room-summary', userId, roomId] }),
  })
}

/** 房间总结获取 hook*/
export function useRoomSummary(roomId: string, receiving = false) {
  const userId = useSession((s) => s.user?.id)
  return useQuery({
    queryKey: ['room-summary', userId, roomId],
    queryFn: ({ signal }) => aiApi.summary(roomId, signal),
    enabled: !!userId,
    refetchInterval: (query) =>
      receiving || query.state.data?.status === 'generating' ? 2000 : false,
    retry: false,
  })
}

/** 流开始前的 JSON 错误保持普通业务外壳，不交给 SSE 解析器。 */
const streamFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
})
/** useCompletion 的请求只发送触发动作；JSON 校验后，数据流仍由 SDK 解析。 */
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

/** 完整成功与请求结束分别通知业务层，错误和取消不覆盖已有结果。 */
type GenerationCallbacks = {
  onSuccess?: (text: string) => void
  onSettled?: () => void
}

/** SDK 解析和编码原生事件，只补充正常结束检查；正文仍交给 useCompletion 管理。 */
const checkedCompletionFetch: typeof fetch = async (input, init) => {
  const response = await completionFetch(input, init)
  let finishReason: string | undefined
  let failed = false
  const stream = parseJsonEventStream({
    stream: response.body!,
    schema: uiMessageChunkSchema,
  })
    .pipeThrough(
      new TransformStream({
        transform(part, controller) {
          if (!part.success) throw part.error
          if (part.value.type === 'finish') finishReason = part.value.finishReason
          if (part.value.type === 'error') failed = true
          controller.enqueue(part.value)
        },
        flush() {
          if (!failed && finishReason !== 'stop')
            throw new HttpError(
              finishReason === 'length' ? 'AI_OUTPUT_TRUNCATED' : 'AI_INCOMPLETE',
              finishReason === 'length'
                ? '生成内容达到输出上限，未完成，请手动重试'
                : '生成未完整结束，请手动重试',
              502,
              null,
            )
        },
      }),
    )
    .pipeThrough(new JsonToSseTransformStream())
    .pipeThrough(new TextEncoderStream())
  return new Response(stream, response)
}

/** SDK 直接管理单段正文；按账号和页面实例隔离临时内容，离页停止接收。 */
function useAiGeneration(api: string, { onSuccess, onSettled }: GenerationCallbacks = {}) {
  const userId = useSession((s) => s.user?.id)
  const instanceId = useId()
  const id = `${userId}:${api}:${instanceId}`
  const requestId = useRef(0)
  // useCompletion 的 error 属于组件状态，只在发起它的账号下展示。
  const [requestedId, setRequestedId] = useState<string>()
  const { completion, isLoading, error, complete, stop, setCompletion } = useCompletion({
    id,
    api,
    streamProtocol: 'data',
    fetch: checkedCompletionFetch,
  })
  useEffect(
    () => () => {
      requestId.current++
      stop()
      setCompletion('')
    },
    [id, stop, setCompletion],
  )

  /** 通过原生结束检查后才通知成功；失效请求不保存，请求结束始终刷新共享状态。 */
  const generate = () => {
    if (isLoading) return
    const currentRequest = ++requestId.current
    setRequestedId(id)
    void complete('')
      .then((text) => {
        if (requestId.current === currentRequest && text?.trim()) onSuccess?.(text)
      })
      .finally(onSettled)
  }
  /** 停止时立即使成功回调失效，不依赖底层网络及时响应取消。 */
  const stopGeneration = () => {
    requestId.current++
    stop()
  }
  return {
    text: completion,
    pending: isLoading,
    error: requestedId === id ? error : undefined,
    generate,
    stop: stopGeneration,
  }
}
