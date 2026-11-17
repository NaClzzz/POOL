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
import { playlistSystem, summarySystem } from './prompts'
import { getRoomSummary, claimRoomSummary, preparePlaylist, prepareSummary } from './service'
import { finishSummary } from './repository'

/** 只接受 URL 归档身份，客户端消息不作为生成资料。 */
type SummaryContext = { params: Promise<{ roomId: string }> }
/** 共用模型与流响应参数；房间入口额外提供保存和失败回写。 */
type GenerationOptions = {
  model: ReturnType<typeof createBailianModel>
  prompt: string
  system: string
  maxOutputTokens: number
  signal: AbortSignal
  requestId: string
  release: () => void
  save?: (text: string) => Promise<void>
  fail?: (code: string) => Promise<unknown>
}
const roomIdSchema = z.string().min(1).max(128)
/** 所有生成响应禁止缓存与代理缓冲，请求编号由入口补充。 */
const streamHeaders = { 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }

/** 准备过程有独立期限，取消后不启动模型；已发出的音乐查询由原有期限收尾。 */
async function prepareWithin(signal: AbortSignal, prepare: () => Promise<string>) {
  signal.throwIfAborted()
  return new Promise<string>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    prepare()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

/** 本人收藏由服务端读取，准备和模型阶段均随客户端取消。 */
export function playlistAnalysisHandler(request: Request) {
  return businessRequest(request, async (userId, requestId) => {
    const release = acquireAiTask(`playlist:${userId}`)
    try {
      const model = createBailianModel()
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
      const prompt = await prepareWithin(signal, () => preparePlaylist(userId, signal))
      signal.throwIfAborted()
      await chargeAiQuota(userId, 'playlist')

      return generateStream({
        model,
        prompt,
        system: playlistSystem,
        maxOutputTokens: 1200,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
        requestId,
        release,
      })
    } catch (error) {
      release()
      throw aiError(error)
    }
  })
}

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

    const release = acquireAiTask(`summary:${roomId}`)
    let attemptId: string | null = null
    try {
      const { attemptId: claimedId } = await claimRoomSummary(userId, roomId)
      if (!claimedId) {
        release()
        return savedSummaryResponse(requestId)
      }
      attemptId = claimedId
      const model = createBailianModel()
      const signal = AbortSignal.timeout(30_000)
      const prompt = await prepareWithin(signal, () => prepareSummary(roomId, signal))
      signal.throwIfAborted()
      await chargeAiQuota(userId, 'summary')

      return generateStream({
        model,
        prompt,
        system: summarySystem,
        maxOutputTokens: 2000,
        signal: AbortSignal.timeout(60_000),
        requestId,
        release,
        save: async (text) => {
          if (!(await finishSummary(roomId, claimedId, text, null)))
            throw new BusinessError('AI_SAVE_FAILED', '总结未保存成功，请刷新状态后重试', 502)
        },
        fail: (code) => finishSummary(roomId, claimedId, null, code),
      })
    } catch (error) {
      release()
      const failure = aiError(error)
      if (attemptId) await finishSummary(roomId, attemptId, null, failure.code)
      throw failure
    }
  })
}

/** 两类业务仅共用模型调用、原生流转发及完整性检查；保存完成后才发送正常结束。 */
function generateStream({
  model,
  prompt,
  system,
  maxOutputTokens,
  signal,
  requestId,
  release,
  save,
  fail,
}: GenerationOptions) {
  signal.throwIfAborted()
  const result = streamText({
    model,
    system,
    prompt,
    maxOutputTokens,
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
        await save?.(text)
        writer.write({ type: 'finish', finishReason: 'stop' })
      } catch (error) {
        const failure = aiError(error)
        await fail?.(failure.code)
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
