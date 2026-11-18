// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const identity = vi.hoisted(() => ({ id: 'a' }))
const notifications = vi.hoisted(() => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/lib/notifications', () => notifications)
vi.mock('@/stores/session', () => ({
  useSession: (select: (s: { user: { id: string } }) => unknown) =>
    select({ user: { id: identity.id } }),
}))
vi.mock('@/lib/auth-client', () => ({ authClient: { getSession: vi.fn() } }))
import { aiApi, useRoomSummaryGeneration } from '@/lib/api-client'
import { RoomSummary } from '@/features/ai/room-summary'

let root: Root, host: HTMLDivElement
let state: ReturnType<typeof useRoomSummaryGeneration>
let requestSignal: AbortSignal | undefined
let finish: () => void
let client: QueryClient
let ending: 'stop' | 'error' | 'length' | 'missing' | 'abort' | 'disconnect'
let text: string
let respectAbort: boolean

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
  text = '流式总结'
  respectAbort = true
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
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
  await renderRoom('room')
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  client.clear()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('房间总结流的页面生命周期', () => {
  it('SDK 逐步显示正文，完整结束后才通知成功并刷新状态', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await act(async () => state.generate())
    await flush()
    expect(state.text).toBe('流式总结')
    expect(state.pending).toBe(true)
    expect(notifications.notifySuccess).not.toHaveBeenCalled()
    await act(async () => finish())
    await flush()
    expect(state.pending).toBe(false)
    expect(notifications.notifySuccess).toHaveBeenCalledExactlyOnceWith('房间总结已生成')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room-summary', 'a', 'room'] })
  })
  it('页面卸载关闭客户端请求，不通知错误或成功', async () => {
    await act(async () => state.generate())
    await flush()
    await act(async () => root.render(null))
    await flush()
    expect(requestSignal?.aborted).toBe(true)
    expect(notifications.notifySuccess).not.toHaveBeenCalled()
    expect(notifications.notifyError).not.toHaveBeenCalled()
  })
  it('换号后旧网络晚到的错误不污染新账号正在生成的结果', async () => {
    let failOld!: (error: Error) => void
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failOld = reject
        }),
    )
    await act(async () => state.generate())
    identity.id = 'b'
    await renderRoom('room')
    await act(async () => state.generate())
    await flush()
    await act(async () => failOld(new TypeError('旧请求失败')))
    await flush()
    await act(async () => finish())
    await flush()
    expect(state.text).toBe('流式总结')
    expect(state.error).toBeUndefined()
    expect(notifications.notifyError).not.toHaveBeenCalled()
    expect(notifications.notifySuccess).toHaveBeenCalledExactlyOnceWith('房间总结已生成')
  })
  it.each(['error', 'missing', 'length', 'abort', 'disconnect'] as const)(
    '%s 结束不作为成功，仅通知一次错误并刷新数据库状态',
    async (mode) => {
      ending = mode
      const invalidate = vi.spyOn(client, 'invalidateQueries')
      await act(async () => state.generate())
      await flush()
      await act(async () => finish())
      await flush()
      expect(state.error).toBeDefined()
      expect(notifications.notifyError).toHaveBeenCalledOnce()
      expect(notifications.notifySuccess).not.toHaveBeenCalled()
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room-summary', 'a', 'room'] })
    },
  )
  it('换号后旧网络忽略取消而正常结束，也不显示或通知旧结果', async () => {
    respectAbort = false
    await act(async () => state.generate())
    await flush()
    const old = requestSignal
    identity.id = 'b'
    await renderRoom('room')
    await flush()
    expect(old?.aborted).toBe(true)
    expect(state.text).toBe('')
    expect(state.error).toBeUndefined()
    expect(notifications.notifySuccess).not.toHaveBeenCalled()
    expect(notifications.notifyError).not.toHaveBeenCalled()
  })
  it('只有正常结束事件的空流会刷新查询，不通知生成成功', async () => {
    text = ''
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await renderRoom('room/id')
    await act(async () => state.generate())
    await flush()
    await act(async () => finish())
    await flush()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room-summary', 'a', 'room/id'] })
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/rooms/room%2Fid/summary')
    expect(state.error).toBeUndefined()
    expect(state.pending).toBe(false)
    expect(notifications.notifySuccess).not.toHaveBeenCalled()
  })
})

describe('共享总结业务 hook', () => {
  it('请求失败也刷新对应总结查询', async () => {
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
    expect(notifications.notifyError).toHaveBeenCalledExactlyOnceWith(state.error)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room-summary', 'a', 'room'] })
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
  })
})
