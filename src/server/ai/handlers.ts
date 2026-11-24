import {
  streamText,
  consumeStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  toUIMessageStream,
} from 'ai'
import { z } from 'zod'
import { businessRequest } from '../http/business'
import { BusinessError } from '../http/errors'
import { createBailianModel, aiError } from './provider'
import { acquireAiTask, chargeAiQuota } from './runtime'
import { summarySystem } from './prompts'
import { getRoomSummary, claimRoomSummary, prepareSummary } from './service'
import { finishSummary } from './repository'

/** 只接受 URL 归档身份，客户端消息不作为生成资料。 */
type SummaryContext = { params: Promise<{ roomId: string }> }
/** 已认领房间总结的生成资料，尝试标识用于隔离保存与失败回写。 */
type SummaryGeneration = {
  model: ReturnType<typeof createBailianModel>
  prompt: string
  roomId: string
  attemptId: string
  requestId: string
  release: () => void
}
const roomIdSchema = z.string().min(1).max(128)
/** 所有生成响应禁止缓存与代理缓冲，请求编号由入口补充。 */
const streamHeaders = { 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }

/** 状态查询不调用模型、不计次数，也不给无历史凭证的人返回正文。 */
export function getSummaryHandler(request: Request, context: SummaryContext) {
  return businessRequest(request, async (userId) => ({
    data: await getRoomSummary(userId, roomIdSchema.parse((await context.params).roomId)),
  }))
}

/** 校验权限并认领后读取房间资料；独立期限保证离页后仍可完成并保存。 */
export function generateSummaryHandler(request: Request, context: SummaryContext) {
  return businessRequest(request, async (userId, requestId) => {
    const roomId = roomIdSchema.parse((await context.params).roomId)
    const current = await getRoomSummary(userId, roomId)
    if (current.status === 'succeeded') return savedSummaryResponse(requestId)
    if (current.status === 'generating')
      throw new BusinessError('AI_IN_PROGRESS', '房间总结正在生成，请稍后查看', 409)

    const release = acquireAiTask()
    let attemptId: string | null = null
    try {
      const claimedId = await claimRoomSummary(userId, roomId)
      if (!claimedId) {
        release()
        return savedSummaryResponse(requestId)
      }
      attemptId = claimedId
      const model = createBailianModel()
      const prepareSignal = AbortSignal.timeout(30_000)
      const prompt = await Promise.race([
        prepareSummary(roomId, prepareSignal),
        new Promise<never>((_, reject) =>
          prepareSignal.addEventListener('abort', () => reject(prepareSignal.reason), {
            once: true,
          }),
        ),
      ])
      await chargeAiQuota(userId)

      return streamSummary({
        model,
        prompt,
        roomId,
        attemptId: claimedId,
        requestId,
        release,
      })
    } catch (error) {
      release()
      const failure = aiError(error)
      if (attemptId) await finishSummary(roomId, attemptId, null, failure.code)
      throw failure
    }
  })
}

/** 房间总结持续生成并回写当前尝试，完整正文保存后才发送正常结束。 */
function streamSummary({
  model,
  prompt,
  roomId,
  attemptId,
  requestId,
  release,
}: SummaryGeneration) {
  const signal = AbortSignal.timeout(60_000)
  const result = streamText({
    model,
    system: summarySystem,
    prompt,
    maxOutputTokens: 2000,
    maxRetries: 0,
    // 流边界统一记录安全错误，关闭 SDK 默认的上游原文日志。
    onError() {},
    abortSignal: signal,
    providerOptions: { bailian: { enable_thinking: false } },
  })
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        await toUIMessageStream({
          stream: result.stream,
          sendReasoning: false,
          sendFinish: false,
          onError(error) {
            throw error
          },
        }).pipeTo(new WritableStream({ write: writer.write }))
        const [text, reason] = await Promise.all([result.text, result.finishReason])
        signal.throwIfAborted()
        if (reason !== 'stop' || !text.trim())
          throw new BusinessError(
            reason === 'length' ? 'AI_OUTPUT_TRUNCATED' : 'AI_UNAVAILABLE',
            reason === 'length'
              ? '生成内容达到输出上限，未完成，请手动重试'
              : '模型未返回完整内容，请手动重试',
            502,
          )
        if (!(await finishSummary(roomId, attemptId, text, null)))
          throw new BusinessError('AI_SAVE_FAILED', '总结未保存成功，请刷新状态后重试', 502)
        writer.write({ type: 'finish', finishReason: 'stop' })
      } catch (error) {
        const failure = aiError(error)
        await finishSummary(roomId, attemptId, null, failure.code)
        throw failure
      } finally {
        release()
      }
    },
    onError: (error) => {
      const failure = aiError(error)
      console.error(`[ai] ${requestId} ${failure.code}`)
      return failure.message
    },
  })
  return createUIMessageStreamResponse({
    stream,
    consumeSseStream: consumeStream,
    headers: { ...streamHeaders, 'X-Request-Id': requestId },
  })
}

/** 已有总结只发送原生结束事件，客户端随后通过 GET 读取正文，不占生成资格或额度。 */
function savedSummaryResponse(requestId: string) {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => writer.write({ type: 'finish', finishReason: 'stop' }),
    }),
    headers: { ...streamHeaders, 'X-Request-Id': requestId },
  })
}
