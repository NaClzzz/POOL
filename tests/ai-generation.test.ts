import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'

const mocks = vi.hoisted(() => ({
  model: vi.fn(),
  prepare: vi.fn(),
  charge: vi.fn(),
  release: vi.fn(),
  finish: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/http/business', () => ({
  businessRequest: async (
    _request: Request,
    action: (id: string, requestId: string) => Promise<Response>,
  ) => {
    try {
      return await action('user', 'request')
    } catch (error) {
      const failure = error as { status: number; code: string }
      return Response.json({ code: failure.code }, { status: failure.status })
    }
  },
}))
vi.mock('@/server/ai/provider', async (original) => ({
  ...(await original<typeof import('@/server/ai/provider')>()),
  createBailianModel: mocks.model,
}))
vi.mock('@/server/ai/runtime', () => ({
  acquireAiTask: () => mocks.release,
  chargeAiQuota: mocks.charge,
}))
vi.mock('@/server/ai/service', () => ({
  preparePlaylist: mocks.prepare,
  prepareSummary: mocks.prepare,
  getRoomSummary: async () => ({ status: 'idle' }),
  claimRoomSummary: async () => ({ summary: { status: 'generating' }, attemptId: 'attempt' }),
}))
vi.mock('@/server/ai/repository', () => ({ finishSummary: mocks.finish }))
import { playlistAnalysisHandler, generateSummaryHandler } from '@/server/ai/handlers'

/** SDK 测试模型的真实流片段，避免手工替代 SDK 的结束和取消逻辑。 */
type ModelPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P>
    ? P
    : never

/** 提供正常完成或等到取消的测试模型。 */
function model(waitForAbort = false) {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<ModelPart>({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 't' })
          controller.enqueue({ type: 'text-delta', id: 't', delta: '部分文字' })
          if (waitForAbort)
            abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason), {
              once: true,
            })
          else {
            controller.enqueue({ type: 'text-end', id: 't' })
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            })
            controller.close()
          }
        },
      }),
    }),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // 原生 AbortSignal.timeout 不由假时钟驱动；只替换时间源，不替换业务取消分支。
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms)
    return controller.signal
  })
  mocks.model.mockReturnValue(model())
  mocks.prepare.mockResolvedValue('资料')
  mocks.finish.mockResolvedValue(true)
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('AI 期限、取消和保存失败', () => {
  it('准备超过三十秒不启动模型、不计额度并释放任务', async () => {
    mocks.prepare.mockImplementationOnce(() => new Promise(() => {}))
    const pending = playlistAnalysisHandler(new Request('http://pool/api', { method: 'POST' }))
    await vi.advanceTimersByTimeAsync(30_001)
    const response = await pending
    expect(response.status).toBe(504)
    expect(mocks.charge).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it('模型六十秒超时，流报告错误且总结保留失败重试状态', async () => {
    mocks.model.mockReturnValue(model(true))
    const response = await generateSummaryHandler(
      new Request('http://pool/api', { method: 'POST' }),
      { params: Promise.resolve({ roomId: 'room' }) },
    )
    const text = response.text()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(await text).toMatch(/超时/)
    expect(mocks.finish).toHaveBeenCalledWith('room', 'attempt', null, 'AI_TIMEOUT')
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it('歌单分析取消会中断 SDK 并释放任务，不误报为成功', async () => {
    mocks.model.mockReturnValue(model(true))
    const controller = new AbortController()
    const response = await playlistAnalysisHandler(
      new Request('http://pool/api', { method: 'POST', signal: controller.signal }),
    )
    const text = response.text()
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    await vi.advanceTimersByTimeAsync(1)
    expect(await text).not.toMatch(/"finishReason":"stop"/)
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it('完整模型输出也必须先保存成功，保存失败不会发送成功结束事件', async () => {
    mocks.finish.mockResolvedValueOnce(false)
    const response = await generateSummaryHandler(
      new Request('http://pool/api', { method: 'POST' }),
      { params: Promise.resolve({ roomId: 'room' }) },
    )
    const text = await response.text()
    expect(text).toMatch(/未保存成功/)
    expect(text).not.toMatch(/"finishReason":"stop"/)
    expect(mocks.finish).toHaveBeenLastCalledWith('room', 'attempt', null, 'AI_SAVE_FAILED')
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
