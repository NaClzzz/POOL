// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const identity = vi.hoisted(() => ({ id: 'a' }))
vi.mock('@/stores/session', () => ({
  useSession: (select: (s: { user: { id: string } }) => unknown) =>
    select({ user: { id: identity.id } }),
}))
vi.mock('@/lib/auth-client', () => ({ authClient: { getSession: vi.fn() } }))
import { aiApi, usePlaylistAnalysisGeneration, useRoomSummaryGeneration } from '@/lib/api-client'
import { GenerationPanel } from '@/features/ai/generation-panel'
import { RoomSummary } from '@/features/ai/room-summary'
import { usePlaylistAnalysis } from '@/stores/playlist-analysis'

let root: Root, host: HTMLDivElement
let state: ReturnType<typeof usePlaylistAnalysisGeneration>
let requestSignal: AbortSignal | undefined
let finish: () => void
let client: QueryClient
let ending: 'stop' | 'error' | 'length' | 'missing' | 'abort' | 'disconnect'
let text: string
let respectAbort: boolean

/** 使用真实 React 和 AI SDK，网络 fixture 保持流打开直到测试主动结束。 */
function Probe() {
  const current = usePlaylistAnalysisGeneration()
  useEffect(() => {
    state = current
  })
  return null
}

/** 通过公开业务 hook 验证账号、房间接口和结束后刷新，不引用内部通用 hook。 */
function RoomProbe({ roomId }: { roomId: string }) {
  const current = useRoomSummaryGeneration(roomId)
  useEffect(() => {
    state = current
  })
  return null
}

/** 总结生成使用真实 QueryClient，查询缓存按账号和房间隔离。 */
async function renderRoom(roomId: string) {
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RoomProbe, { roomId })),
    ),
  )
}

/** 等待 SDK 流解析和 React 提交，不依赖实际服务。 */
async function flush() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2))
    })
}

beforeEach(async () => {
  identity.id = 'a'
  ending = 'stop'
  text = '流式赏析'
  respectAbort = true
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  usePlaylistAnalysis.setState({ results: {} })
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init: RequestInit) => {
      requestSignal = init.signal ?? undefined
      const response = createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: async ({ writer }) => {
            if (text) {
              writer.write({ type: 'start', messageId: 'answer' })
              writer.write({ type: 'text-start', id: 'text' })
              writer.write({ type: 'text-delta', id: 'text', delta: text })
            }
            await new Promise<void>((resolve) => {
              finish = resolve
              requestSignal?.addEventListener('abort', () => resolve(), { once: true })
            })
            if (text) writer.write({ type: 'text-end', id: 'text' })
            if (ending === 'error') {
              writer.write({ type: 'error', errorText: '生成内容达到输出上限，未完成，请手动重试' })
            } else if (ending === 'abort') writer.write({ type: 'abort' })
            else if (ending === 'stop' || ending === 'length')
              writer.write({ type: 'finish', finishReason: ending })
          },
        }),
      })
      // 模拟浏览器 fetch：取消请求时 body 读取也必须中断。
      return new Response(
        response.body!.pipeThrough(
          new TransformStream({
            flush() {
              if (ending === 'disconnect') throw new TypeError('连接中断')
            },
          }),
          {
            signal: respectAbort ? (init.signal ?? undefined) : undefined,
          },
        ),
        response,
      )
    }),
  )
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(Probe)))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  client.clear()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('真实 AI hook 的页面生命周期', () => {
  it('真实 SDK 逐步显示文本，主动停止中断当前请求', async () => {
    await act(async () => state.generate())
    await flush()
    expect(state.text).toBe('流式赏析')
    expect(state.pending).toBe(true)
    await act(async () => {
      await state.stop()
    })
    expect(requestSignal?.aborted).toBe(true)
    expect(state.pending).toBe(false)
    expect(usePlaylistAnalysis.getState().results.a).toBeUndefined()
  })
  it('页面卸载会关闭客户端请求；共享任务是否继续由服务端决定', async () => {
    await act(async () => state.generate())
    await flush()
    await act(async () => root.unmount())
    expect(requestSignal?.aborted).toBe(true)
  })
  it('账号切换中止旧请求且不显示旧账号的流文字', async () => {
    await act(async () => state.generate())
    await flush()
    const old = requestSignal
    identity.id = 'b'
    await act(async () => root.render(createElement(Probe)))
    await flush()
    expect(old?.aborted).toBe(true)
    expect(state.text).toBe('')
    expect(state.pending).toBe(false)
  })
  it('完成后保存本人分析，再生成会替换而非追加上一轮文字', async () => {
    await act(async () => state.generate())
    await flush()
    await act(async () => finish())
    await flush()
    expect(usePlaylistAnalysis.getState().results.a).toBe('流式赏析')
    expect(state.pending).toBe(false)
    await act(async () => state.generate())
    await flush()
    expect(state.text).toBe('流式赏析')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('截断结束不作为完整结果保存', async () => {
    ending = 'error'
    await act(async () => state.generate())
    await flush()
    await act(async () => finish())
    await flush()
    expect(usePlaylistAnalysis.getState().results.a).toBeUndefined()
    expect(state.error?.message).toContain('输出上限')
  })
  it.each(['missing', 'length', 'abort', 'disconnect'] as const)(
    '%s 结束不能把读取结束当成成功，也不持久化半成品',
    async (mode) => {
      ending = mode
      usePlaylistAnalysis.getState().save('a', '已有完整结果')
      await act(async () => root.render(createElement(GenerationPanel)))
      await generateFromPanel()
      await act(async () => finish())
      await flush()
      expect(host.querySelector('[role="alert"]')).not.toBeNull()
      expect(usePlaylistAnalysis.getState().results.a).toBe('已有完整结果')
    },
  )
  it('只有正常结束事件的空流会刷新总结查询，不保存空正文', async () => {
    text = ''
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await renderRoom('room/id')
    await act(async () => state.generate())
    await flush()
    await act(async () => finish())
    await flush()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room-summary', 'a', 'room/id'] })
    expect(usePlaylistAnalysis.getState().results).toEqual({})
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/rooms/room%2Fid/summary')
    expect(state.error).toBeUndefined()
    expect(state.pending).toBe(false)
  })
  it('换号后即使旧网络忽略取消而正常结束，也不会保存旧请求结果', async () => {
    respectAbort = false
    await act(async () => root.render(createElement(GenerationPanel)))
    await generateFromPanel()
    identity.id = 'b'
    await act(async () => root.render(createElement(GenerationPanel)))
    await flush()
    expect(usePlaylistAnalysis.getState().results).toEqual({})
    expect(host.textContent).not.toContain('流式赏析')
  })
  it('手动取消立即使保存回调失效，即使底层网络忽略取消后正常结束', async () => {
    respectAbort = false
    usePlaylistAnalysis.getState().save('a', '已有完整结果')
    await act(async () => root.render(createElement(GenerationPanel)))
    await generateFromPanel()
    await act(async () => host.querySelector('button')!.click())
    await flush()
    expect(requestSignal?.aborted).toBe(true)
    expect(usePlaylistAnalysis.getState().results.a).toBe('已有完整结果')
  })
})

describe('共享总结业务 hook', () => {
  it('请求失败也刷新对应总结查询，不把正文保存到本地分析', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        {
          ok: false,
          requestId: 'r',
          error: { code: 'AI_IN_PROGRESS', message: '总结正在生成' },
        },
        { status: 409 },
      ),
    )
    await renderRoom('room')
    await act(async () => state.generate())
    await flush()
    expect(state.error?.message).toBe('总结正在生成')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room-summary', 'a', 'room'] })
    expect(usePlaylistAnalysis.getState().results).toEqual({})
  })
  it('换号使旧请求失效，结束时只刷新发起账号与房间的查询', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await renderRoom('room')
    await act(async () => state.generate())
    await flush()
    const old = requestSignal
    identity.id = 'b'
    await renderRoom('room')
    await flush()
    expect(old?.aborted).toBe(true)
    expect(state.text).toBe('')
    expect(state.error).toBeUndefined()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room-summary', 'a', 'room'] })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['room-summary', 'b', 'room'] })
  })
  it('离开详情停止接收并刷新原房间，不影响新房间的内容', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await renderRoom('old')
    await act(async () => state.generate())
    await flush()
    const old = requestSignal
    await renderRoom('new')
    await flush()
    expect(old?.aborted).toBe(true)
    expect(state.text).toBe('')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room-summary', 'a', 'old'] })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['room-summary', 'a', 'new'] })
  })
  it('服务端只结束空流后，页面通过 GET 展示保存结果且锁定生成按钮', async () => {
    const saved = {
      roomId: 'room',
      status: 'succeeded' as const,
      content: '数据库中的共享总结',
      errorCode: null,
      generatedAt: '2026-11-17',
      expiresAt: '2026-11-24',
    }
    const summary = vi
      .spyOn(aiApi, 'summary')
      .mockResolvedValueOnce({ ...saved, status: 'idle', content: null })
      .mockResolvedValue(saved)
    text = ''
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(RoomSummary, { roomId: 'room' }),
        ),
      ),
    )
    await flush()
    expect(host.textContent).toContain('生成房间总结')
    await act(async () => host.querySelector('button')!.click())
    await flush()
    await act(async () => finish())
    await flush()
    expect(summary).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('数据库中的共享总结')
    expect(host.querySelector('button')).toBeNull()
    expect(usePlaylistAnalysis.getState().results).toEqual({})
  })
})

/** 通过真实组件点击生成，验证 SDK 完成结果实际进入 persist，而非只测 store setter。 */
async function generateFromPanel() {
  await act(async () => host.querySelector('button')!.click())
  await flush()
}

describe('歌单分析结果持久化', () => {
  it('只保存完整结果，重新挂载从 localStorage 恢复且不再次请求模型', async () => {
    await act(async () => root.render(createElement(GenerationPanel)))
    await generateFromPanel()
    expect(usePlaylistAnalysis.getState().results.a).toBeUndefined()
    await act(async () => finish())
    await flush()
    expect(usePlaylistAnalysis.getState().results.a).toBe('流式赏析')
    const stored = localStorage.getItem('pool:playlist-analysis:v1')!
    expect(JSON.parse(stored).state).toEqual({ results: { a: '流式赏析' } })

    await act(async () => root.render(null))
    usePlaylistAnalysis.setState({ results: {} })
    localStorage.setItem('pool:playlist-analysis:v1', stored)
    await act(async () => root.render(createElement(GenerationPanel)))
    expect(host.textContent).toContain('流式赏析')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('按账号恢复各自结果，换号不展示或写入另一个账号的分析', async () => {
    usePlaylistAnalysis.getState().save('a', '甲的完整结果')
    usePlaylistAnalysis.getState().save('b', '乙的完整结果')
    await act(async () => root.render(createElement(GenerationPanel)))
    expect(host.textContent).toContain('甲的完整结果')
    await generateFromPanel()
    const previous = requestSignal
    identity.id = 'b'
    await act(async () => root.render(createElement(GenerationPanel)))
    await flush()
    expect(previous?.aborted).toBe(true)
    expect(host.textContent).toContain('乙的完整结果')
    expect(host.textContent).not.toContain('甲的完整结果')
    expect(usePlaylistAnalysis.getState().results).toEqual({ a: '甲的完整结果', b: '乙的完整结果' })
    identity.id = 'a'
    await act(async () => root.render(createElement(GenerationPanel)))
    await flush()
    expect(host.textContent).toContain('甲的完整结果')
    expect(host.textContent).not.toContain('流式赏析')
  })
  it('取消、失败和离页不使用半成品覆盖之前的完整结果', async () => {
    usePlaylistAnalysis.getState().save('a', '已有完整结果')
    await act(async () => root.render(createElement(GenerationPanel)))
    await generateFromPanel()
    await act(async () => host.querySelector('button')!.click())
    await flush()
    expect(usePlaylistAnalysis.getState().results.a).toBe('已有完整结果')

    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        {
          ok: false,
          requestId: 'r',
          error: { code: 'RATE_LIMITED', message: '稍后重试' },
        },
        { status: 429 },
      ),
    )
    await generateFromPanel()
    expect(host.textContent).toContain('稍后重试')
    expect(usePlaylistAnalysis.getState().results.a).toBe('已有完整结果')

    await generateFromPanel()
    await act(async () => root.render(null))
    await flush()
    expect(requestSignal?.aborted).toBe(true)
    expect(usePlaylistAnalysis.getState().results.a).toBe('已有完整结果')
  })
})
