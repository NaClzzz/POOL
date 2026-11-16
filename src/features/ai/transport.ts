import { createUIMessageStream, createUIMessageStreamResponse, DefaultChatTransport } from 'ai'
import { z } from 'zod'
import { roomSummarySchema } from '@/contracts/ai'
import { authClient } from '@/lib/auth-client'
import { HttpError } from '@/lib/http'

/** 流开始前的 JSON 错误保持普通业务外壳，不交给 SSE 解析器。 */
const streamFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
})
const savedSummarySchema = z.object({
  ok: z.literal(true),
  data: roomSummarySchema,
  requestId: z.string(),
})

/** 单次生成只发送触发动作；正文及身份由服务端读取，SDK 负责流解析和取消。 */
export function generationTransport(api: string) {
  return new DefaultChatTransport({
    api,
    prepareSendMessagesRequest: () => ({ body: {} }),
    fetch: async (input, init) => {
      let response: Response
      try {
        response = await fetch(input, init)
      } catch (error) {
        if (init?.signal?.aborted) throw error
        throw new HttpError('NETWORK_ERROR', '无法连接生成服务，请检查网络后手动重试', 0, null)
      }
      if (response.status === 401) void authClient.getSession()
      if (response.headers.get('Content-Type')?.includes('application/json')) {
        const raw: unknown = await response.json().catch(() => null)
        const failure = streamFailureSchema.safeParse(raw)
        if (failure.success)
          throw new HttpError(
            failure.data.error.code,
            failure.data.error.message,
            response.status,
            Number(response.headers.get('Retry-After')) || null,
          )
        const saved = savedSummarySchema.safeParse(raw)
        if (response.ok && saved.success && saved.data.data.status === 'succeeded') {
          // 并发触发时服务端可能已完成；用 SDK 原生空流结束本地请求。
          return createUIMessageStreamResponse({
            stream: createUIMessageStream({
              execute: ({ writer }) => {
                writer.write({ type: 'finish', finishReason: 'stop' })
              },
            }),
          })
        }
      } else if (response.ok && response.headers.get('Content-Type')?.includes('text/event-stream'))
        return response
      throw new HttpError(
        'INVALID_RESPONSE',
        '生成服务返回的数据格式异常，请手动重试',
        response.status,
        null,
      )
    },
  })
}
