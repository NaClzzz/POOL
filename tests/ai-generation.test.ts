import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'

const mocks = vi.hoisted(() => ({
  model: vi.fn(),
  prepare: vi.fn(),
  charge: vi.fn(),
  release: vi.fn(),
  finish: vi.fn(),
  summary: vi.fn(),
  claim: vi.fn(),
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
  getRoomSummary: mocks.summary,
  claimRoomSummary: mocks.claim,
}))
vi.mock('@/server/ai/repository', () => ({ finishSummary: mocks.finish }))
import { playlistAnalysisHandler, generateSummaryHandler } from '@/server/ai/handlers'

/** SDK 测试模型的真实流片段，避免手工替代 SDK 的结束和取消逻辑。 */
type ModelPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P>
    ? P
    : never

/** 控制测试模型的正文、结束原因及取消时机，覆盖完整输出和中途结束。 */
function model(
  waitForAbort = false,
  finishReason: 'stop' | 'length' | 'missing' = 'stop',
  text = '部分文字',
) {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<ModelPart>({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 't' })
          controller.enqueue({ type: 'text-delta', id: 't', delta: text })
          if (waitForAbort)
            abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason), {
              once: true,
            })
          else {
            controller.enqueue({ type: 'text-end', id: 't' })
            if (finishReason !== 'missing')
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: finishReason, raw: finishReason },
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
  mocks.summary.mockResolvedValue({ status: 'idle' })
  mocks.claim.mockResolvedValue({ summary: { status: 'generating' }, attemptId: 'attempt' })
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('AI 期限、取消和保存失败', () => {
  it('已有总结直接返回原生空 SSE，不检查模型配置、不占生成资格或额度', async () => {
    mocks.summary.mockResolvedValueOnce({ status: 'succeeded', content: '已保存总结' })
    const response = await generateSummaryHandler(
      new Request('http://pool/api', { method: 'POST' }),
      { params: Promise.resolve({ roomId: 'room' }) },
    )
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    const output = await response.text()
    expect(output).toContain('"finishReason":"stop"')
    expect(output).not.toContain('已保存总结')
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.charge).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  })
  it('认领时另一请求已保存总结，同样只结束流并释放本次资格', async () => {
    mocks.claim.mockResolvedValueOnce({ attemptId: null })
    const response = await generateSummaryHandler(
      new Request('http://pool/api', { method: 'POST' }),
      { params: Promise.resolve({ roomId: 'room' }) },
    )
    expect(await response.text()).toContain('"finishReason":"stop"')
    expect(mocks.model).not.toHaveBeenCalled()
    expect(mocks.charge).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
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
  it.each(['missing', 'length', 'empty'] as const)(
    '上游 %s 输出不会保存或发送正常结束事件',
    async (ending) => {
      mocks.model.mockReturnValue(
        model(false, ending === 'empty' ? 'stop' : ending, ending === 'empty' ? '  ' : '部分文字'),
      )
      const response = await generateSummaryHandler(
        new Request('http://pool/api', { method: 'POST' }),
        { params: Promise.resolve({ roomId: 'room' }) },
      )
      const output = await response.text()
      expect(output).not.toContain('"finishReason":"stop"')
      expect(output).toContain('error')
      expect(mocks.finish).toHaveBeenCalledWith('room', 'attempt', null, expect.any(String))
      expect(mocks.release).toHaveBeenCalledOnce()
    },
  )
  it('总结保存尚未完成时，流不能提前报告成功', async () => {
    let save: (value: boolean) => void
    mocks.finish.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          save = resolve
        }),
    )
    const response = await generateSummaryHandler(
      new Request('http://pool/api', { method: 'POST' }),
      { params: Promise.resolve({ roomId: 'room' }) },
    )
    let closed = false
    const output = response.text().then((text) => {
      closed = true
      return text
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.finish).toHaveBeenCalledWith('room', 'attempt', '部分文字', null)
    expect(closed).toBe(false)
    save!(true)
    expect(await output).toContain('"finishReason":"stop"')
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
