import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
vi.mock('@/lib/auth-client', () => ({ authClient: { getSession: vi.fn() } }))
import { authClient } from '@/lib/auth-client'
import { generationTransport } from '@/features/ai/transport'

/** 实际执行 SDK 传输与协议解析，只有网络由 fixture 替代。 */
function send(signal = new AbortController().signal) {
  return generationTransport('/api/ai/liked-playlist-analysis').sendMessages({
    trigger: 'submit-message',
    chatId: 'test',
    messageId: undefined,
    abortSignal: signal,
    messages: [
      {
        id: 'ignored',
        role: 'user',
        parts: [{ type: 'text', text: '不应发给服务端的任意提示词' }],
      },
    ],
  })
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('AI SDK 流式传输', () => {
  it('只提交触发动作，并正确解析原生文字流', async () => {
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
    const parts: unknown[] = []
    await (
      await send()
    ).pipeTo(
      new WritableStream({
        write: (part) => {
          parts.push(part)
        },
      }),
    )
    expect(parts).toContainEqual({ type: 'text-delta', id: 'text', delta: '真实流式内容' })
    expect(
      JSON.parse((network.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string),
    ).toEqual({})
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
    await expect(send()).rejects.toMatchObject({ status: 401 })
    expect(authClient.getSession).toHaveBeenCalledOnce()
    await expect(send()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 45 })
    expect(network).toHaveBeenCalledTimes(2)
  })
  it('已有成功总结的 JSON 使用 SDK 空流结束，不再调用生成', async () => {
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
    await expect((await send()).pipeTo(new WritableStream())).resolves.toBeUndefined()
  })
  it('网络错误和主动取消分别处理', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    await expect(send()).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(controller.signal.reason))
    await expect(send(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
