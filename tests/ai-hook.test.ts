// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'

const identity = vi.hoisted(() => ({ id: 'a' }))
vi.mock('@/stores/session', () => ({
  useSession: (select: (s: { user: { id: string } }) => unknown) =>
    select({ user: { id: identity.id } }),
}))
vi.mock('@/lib/auth-client', () => ({ authClient: { getSession: vi.fn() } }))
import { useAiGeneration } from '@/features/ai/use-ai-generation'

let root: Root, host: HTMLDivElement
let state: ReturnType<typeof useAiGeneration>
let requestSignal: AbortSignal | undefined
let finish: () => void
const settled = vi.fn()

/** 使用真实 React 和 AI SDK，网络 fixture 保持流打开直到测试主动结束。 */
function Probe() {
  const current = useAiGeneration('/api/ai/liked-playlist-analysis', settled)
  useEffect(() => {
    state = current
  })
  return null
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
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init: RequestInit) => {
      requestSignal = init.signal ?? undefined
      return createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: async ({ writer }) => {
            writer.write({ type: 'start', messageId: 'answer' })
            writer.write({ type: 'text-start', id: 'text' })
            writer.write({ type: 'text-delta', id: 'text', delta: '流式赏析' })
            await new Promise<void>((resolve) => {
              finish = resolve
              requestSignal?.addEventListener('abort', () => resolve(), { once: true })
            })
            writer.write({ type: 'text-end', id: 'text' })
            writer.write({ type: 'finish', finishReason: 'stop' })
          },
        }),
      })
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
  vi.unstubAllGlobals()
  vi.clearAllMocks()
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
  it('完成后通知查询刷新，再生成会替换而非追加上一轮文字', async () => {
    await act(async () => state.generate())
    await flush()
    await act(async () => finish())
    await flush()
    expect(settled).toHaveBeenCalledOnce()
    expect(state.pending).toBe(false)
    await act(async () => state.generate())
    await flush()
    expect(state.text).toBe('流式赏析')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
