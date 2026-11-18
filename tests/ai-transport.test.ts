// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
vi.mock('@/lib/notifications', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/lib/auth-client', () => ({ authClient: { getSession: vi.fn() } }))
vi.mock('@/stores/session', () => ({
  useSession: (select: (s: { user: { id: string } }) => unknown) => select({ user: { id: 'a' } }),
}))
import { authClient } from '@/lib/auth-client'
import { useRoomSummaryGeneration } from '@/lib/api-client'

let root: Root, host: HTMLDivElement, client: QueryClient
let generation: ReturnType<typeof useRoomSummaryGeneration>

/** 从公开业务 hook 验证内部请求边界，不为测试导出内部 fetch。 */
function Probe() {
  const current = useRoomSummaryGeneration('room')
  useEffect(() => {
    generation = current
  })
  return null
}

/** 等待真实 SDK 的异步流和错误更新完成。 */
async function send() {
  await act(async () => generation.generate())
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2))
    })
}

beforeEach(async () => {
  client = new QueryClient()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe))),
  )
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  client.clear()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('AI Completion 请求边界', () => {
  it('固定总结接口只提交触发动作，SDK 解析原生正文流', async () => {
    const network = vi.fn(async () =>
      createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => {
            writer.write({ type: 'start', messageId: 'result' })
            writer.write({ type: 'text-start', id: 'text' })
            writer.write({ type: 'text-delta', id: 'text', delta: '真实流式内容' })
            writer.write({ type: 'text-end', id: 'text' })
            writer.write({ type: 'finish', finishReason: 'stop' })
          },
        }),
      }),
    )
    vi.stubGlobal('fetch', network)
    await send()
    expect(generation.text).toBe('真实流式内容')
    expect(generation.error).toBeUndefined()
    const [input, init] = vi.mocked(fetch).mock.calls[0]
    expect(input).toBe('/api/rooms/room/summary')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({})
  })
  it('401 刷新会话，429 保留等待秒数，不将 JSON 交给流解析', async () => {
    const network = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { ok: false, requestId: 'r', error: { code: 'UNAUTHENTICATED', message: '请先登录' } },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { ok: false, requestId: 'r', error: { code: 'RATE_LIMITED', message: '稍后重试' } },
          { status: 429, headers: { 'Retry-After': '45' } },
        ),
      )
    vi.stubGlobal('fetch', network)
    await send()
    expect(generation.error).toMatchObject({ status: 401 })
    expect(authClient.getSession).toHaveBeenCalledOnce()
    await send()
    expect(generation.error).toMatchObject({ code: 'RATE_LIMITED', retryAfter: 45 })
    expect(network).toHaveBeenCalledTimes(2)
  })
  it('成功 JSON 属于无效生成响应，不在浏览器构造空流', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          requestId: 'r',
          data: {
            roomId: 'room',
            status: 'succeeded',
            content: '共享总结',
            generatedAt: '2026-11-16',
            expiresAt: '2026-11-23',
            errorCode: null,
          },
        }),
      ),
    )
    await send()
    expect(generation.error).toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('服务端空 SSE 正常结束，不保存空正文', async () => {
    const response = createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: ({ writer }) => writer.write({ type: 'finish', finishReason: 'stop' }),
      }),
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await send()
    expect(generation.text).toBe('')
    expect(generation.error).toBeUndefined()
    expect(generation.pending).toBe(false)
  })
  it('非 JSON 或格式损坏的响应返回统一错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('<html>error</html>'))
        .mockResolvedValueOnce(
          new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }),
        ),
    )
    await send()
    expect(generation.error).toMatchObject({ code: 'INVALID_RESPONSE' })
    await send()
    expect(generation.error).toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('网络失败显示统一错误，主动取消及错误 JSON 接收期间取消不显示网络错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    await send()
    expect(generation.error).toMatchObject({ code: 'NETWORK_ERROR' })

    let signal: AbortSignal
    vi.stubGlobal(
      'fetch',
      vi.fn((_input, init: RequestInit) => {
        signal = init.signal!
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }),
    )
    await send()
    await act(async () => root.render(null))
    expect(signal!.aborted).toBe(true)
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe))),
    )
    expect(generation.error).toBeUndefined()

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init: RequestInit) => {
        signal = init.signal!
        return {
          status: 429,
          ok: false,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: () =>
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            }),
        }
      }),
    )
    await send()
    await act(async () => root.render(null))
    expect(signal!.aborted).toBe(true)
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe))),
    )
    expect(generation.error).toBeUndefined()
  })
})
