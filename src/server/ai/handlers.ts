import {
  streamText,
  createUIMessageStream,
  createUIMessageStreamResponse,
  toUIMessageStream,
} from 'ai'
import { z } from 'zod'
import { businessRequest } from '../http/business'
import { BusinessError } from '../http/errors'
import { success } from '../http/response'
import { createBailianModel, aiError } from './provider'
import { acquireAiTask, chargeAiQuota } from './runtime'
import { playlistSystem, summarySystem } from './prompts'
import { getRoomSummary, claimRoomSummary, preparePlaylist, prepareSummary } from './service'
import { finishSummary } from './repository'

/** 只接受 URL 归档身份，客户端消息不作为生成资料。 */
type SummaryContext = { params: Promise<{ roomId: string }> }
/** 两种流式任务共用生成管线，房间尝试只用于数据库完成确认。 */
type Generation = {
  kind: 'playlist' | 'summary'
  userId: string
  requestId: string
  request: Request
  release: () => void
  room?: { id: string; attemptId: string }
}
const roomIdSchema = z.string().min(1).max(128)

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

/** 生成错误统一记录失败，只有完整输出且落库成功才发送正常结束事件。 */
async function generationResponse(task: Generation) {
  const { room, requestId, kind } = task
  let handedOff = false
  try {
    const model = createBailianModel()
    const preparationSignal =
      kind === 'playlist'
        ? AbortSignal.any([task.request.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000)
    const prompt = await prepareWithin(preparationSignal, () =>
      room
        ? prepareSummary(room.id, preparationSignal)
        : preparePlaylist(task.userId, preparationSignal),
    )
    preparationSignal.throwIfAborted()
    await chargeAiQuota(task.userId, kind)
    const modelSignal =
      kind === 'playlist'
        ? AbortSignal.any([task.request.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000)
    modelSignal.throwIfAborted()
    const result = streamText({
      model,
      system: room ? summarySystem : playlistSystem,
      prompt,
      maxOutputTokens: room ? 2000 : 1200,
      maxRetries: 0,
      // 统一由下方流边界记录安全错误，关闭 SDK 默认的上游原文日志。
      onError() {},
      abortSignal: modelSignal,
      providerOptions: { bailian: { enable_thinking: false } },
    })
    // 服务端持有消费端；共享总结不使用 request.signal，客户端离开不会中断落库。
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        try {
          const checked = result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type === 'error') throw part.error
                controller.enqueue(part)
              },
            }),
          )
          await toUIMessageStream({
            stream: checked,
            sendReasoning: false,
            sendFinish: false,
          }).pipeTo(
            new WritableStream({
              write(part) {
                writer.write(part)
              },
            }),
          )
          const [text, reason] = await Promise.all([result.text, result.finishReason])
          if (modelSignal.aborted) throw modelSignal.reason
          if (reason !== 'stop' || !text.trim())
            throw new BusinessError(
              reason === 'length' ? 'AI_OUTPUT_TRUNCATED' : 'AI_UNAVAILABLE',
              reason === 'length'
                ? '生成内容达到输出上限，未完成，请手动重试'
                : '模型未返回完整内容，请手动重试',
              502,
            )
          if (room && !(await finishSummary(room.id, room.attemptId, text, null)))
            throw new BusinessError('AI_SAVE_FAILED', '总结未保存成功，请刷新状态后重试', 502)
          writer.write({ type: 'finish', finishReason: 'stop' })
        } catch (error) {
          const failure = aiError(error)
          if (room) await finishSummary(room.id, room.attemptId, null, failure.code)
          throw failure
        } finally {
          task.release()
        }
      },
      onError: (error) => {
        const failure = aiError(error)
        console.error(`[ai] ${requestId} ${failure.code}`)
        return failure.message
      },
    })
    // 对最终 UI 流也保留独立消费分支，确保断开后继续执行并完成持久化。
    const [browser, background] = stream.tee()
    void background.pipeTo(new WritableStream({ write() {} })).catch(() => {
      console.error(`[ai] ${requestId} STREAM_FAILED`)
    })
    handedOff = true
    return createUIMessageStreamResponse({
      stream: browser,
      headers: {
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId,
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    const failure = aiError(error)
    if (room) await finishSummary(room.id, room.attemptId, null, failure.code)
    throw failure
  } finally {
    if (!handedOff) task.release()
  }
}

/** 真实本人收藏分析只接受触发动作，资料来自服务端。 */
export function playlistAnalysisHandler(request: Request) {
  return businessRequest(request, (userId, requestId) =>
    generationResponse({
      kind: 'playlist',
      userId,
      requestId,
      request,
      release: acquireAiTask(`playlist:${userId}`),
    }),
  )
}

/** 状态查询不调用模型、不计次数，也不给无历史凭证的人返回正文。 */
export function getSummaryHandler(request: Request, context: SummaryContext) {
  return businessRequest(request, async (userId) => ({
    data: await getRoomSummary(userId, roomIdSchema.parse((await context.params).roomId)),
  }))
}

/** 读取共享成功结果优先于并发名额；认领时仍在事务内重新检查状态。 */
export function generateSummaryHandler(request: Request, context: SummaryContext) {
  return businessRequest(request, async (userId, requestId) => {
    const roomId = roomIdSchema.parse((await context.params).roomId)
    const current = await getRoomSummary(userId, roomId)
    if (current.status === 'succeeded') return success(current, requestId)
    if (current.status === 'generating')
      throw new BusinessError('AI_IN_PROGRESS', '房间总结正在生成，请稍后查看', 409)
    const release = acquireAiTask(`summary:${roomId}`)
    let claim
    try {
      claim = await claimRoomSummary(userId, roomId)
    } catch (error) {
      release()
      throw error
    }
    if (!claim.attemptId) {
      release()
      return success(claim.summary, requestId)
    }
    return generationResponse({
      kind: 'summary',
      userId,
      requestId,
      request,
      release,
      room: { id: roomId, attemptId: claim.attemptId },
    })
  })
}
