import { createServer, type IncomingMessage } from 'node:http'
import type { AxiosInstance } from 'axios'
import type { ApiSuccess } from '@/contracts/domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { refreshSession } = vi.hoisted(() => ({ refreshSession: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/auth-client', () => ({ authClient: { getSession: refreshSession } }))

/** 使用真实 HTTP 测试 Axios 的编码、严格解析、取消及非 2xx 分支。 */
type Reply = {
  status?: number
  body?: unknown
  raw?: string
  retryAfter?: string
  disconnect?: boolean
  delay?: boolean
}
let reply: Reply = {}
const received: { method: string; url: string; body: unknown; contentType?: string }[] = []
const fixture = createServer(async (request, response) => {
  const body = await readBody(request)
  received.push({
    method: request.method!,
    url: request.url!,
    body,
    contentType: request.headers['content-type'],
  })
  if (reply.disconnect) {
    request.socket.destroy()
    return
  }
  if (reply.delay) return
  response.statusCode = reply.status ?? 200
  response.setHeader('Content-Type', 'application/json')
  if (reply.retryAfter) response.setHeader('Retry-After', reply.retryAfter)
  response.end(
    reply.raw ?? JSON.stringify(reply.body ?? { ok: true, data: null, requestId: 'test' }),
  )
})

/** 只在测试端读取提交 JSON，确认对象没有被重复序列化。 */
async function readBody(request: IncomingMessage) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString()
  return body ? JSON.parse(body) : null
}

let api: typeof import('@/lib/api-client')
let transport: AxiosInstance
beforeAll(async () => {
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  const { http } = await import('@/lib/http')
  expect(http.defaults.baseURL).toBe('/api')
  transport = http
  api = await import('@/lib/api-client')
  const address = fixture.address() as { port: number }
  transport.defaults.baseURL = `http://127.0.0.1:${address.port}/api`
  transport.defaults.proxy = false
})
beforeEach(() => {
  reply = {}
  received.length = 0
  refreshSession.mockClear()
})
afterAll(async () => {
  fixture.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  )
})

const track = {
  source: 'netease' as const,
  source_id: '123',
  title: '歌曲',
  author: null,
  album: null,
  duration_ms: null,
  cover_url: null,
  extra: null,
}

describe('Axios 业务 JSON 客户端', () => {
  it('http 保留原始 Axios 响应，业务方法才取出数据', async () => {
    reply.body = { ok: true, data: { value: 1 }, requestId: 'test' }
    const response = await transport.get<ApiSuccess<{ value: number }>>('/probe')
    expect(response.status).toBe(200)
    expect(response.data).toEqual(reply.body)
    expect(response.headers['content-type']).toBe('application/json')
    expect(received[0].url).toBe('/api/probe')
  })

  it('解包搜索和喜欢结果，保留编码参数及无额外超时', async () => {
    const page = { items: [track], offset: 0, limit: 30, total: 1, hasMore: false }
    reply.body = { ok: true, data: page, requestId: 'test' }
    expect(await api.musicApi.search('netease', '风 & 雨')).toEqual(page)
    expect(new URL(received[0].url, 'http://localhost').searchParams.get('q')).toBe('风 & 雨')
    expect(received[0].url).toMatch(/^\/api\/music\/search\?/)
    expect(received[0].contentType).toBeUndefined()
    expect(await api.likesApi.list()).toEqual([track])
    expect(transport.defaults.timeout).toBe(0)
  })

  it('收藏和播放提交对象，成功 201 仍解包', async () => {
    reply = {
      status: 201,
      body: { ok: true, data: { added: true, item: track }, requestId: 'test' },
    }
    expect(await api.likesApi.add(track)).toMatchObject({ added: true })
    expect(received[0]).toMatchObject({
      method: 'POST',
      body: { track },
      contentType: 'application/json',
    })
    reply.body = { ok: true, data: { url: 'https://example.com/audio' }, requestId: 'test' }
    await api.musicApi.playback(track)
    expect(received[1].body).toEqual({ source: 'netease', source_id: '123', extra: null })
  })

  it('取消、清空使用 DELETE，导入保留原 JSON 输入', async () => {
    expect(await api.likesApi.remove(track)).toBeNull()
    expect(await api.likesApi.clear()).toBeNull()
    expect(received.slice(0, 2).map((request) => request.method)).toEqual(['DELETE', 'DELETE'])
    expect(received[1].url).toBe('/api/likes/clear')
    const url = 'https://music.163.com/#/playlist?id=123'
    await api.likesApi.import(url)
    expect(received[2].body).toEqual({ source: 'netease', url })
  })

  it('401 保留业务错误并触发会话刷新', async () => {
    reply = {
      status: 401,
      body: {
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: '请先登录' },
        requestId: 'test',
      },
    }
    await expect(api.likesApi.list()).rejects.toMatchObject({
      name: 'HttpError',
      code: 'UNAUTHENTICATED',
      status: 401,
    })
    expect(refreshSession).toHaveBeenCalledOnce()
  })

  it('429 和其他业务错误保留状态与 Retry-After，不自动重试', async () => {
    reply = {
      status: 429,
      retryAfter: '12',
      body: { ok: false, error: { code: 'RATE_LIMITED', message: '稍后重试' }, requestId: 'test' },
    }
    await expect(api.musicApi.search('netease', 'test')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: 12,
    })
    expect(received).toHaveLength(1)
    reply = {
      status: 502,
      body: {
        ok: false,
        error: { code: 'UPSTREAM_UNAVAILABLE', message: '音源失败' },
        requestId: 'test',
      },
    }
    await expect(api.musicApi.lyrics('netease', '123')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      status: 502,
      retryAfter: null,
    })
  })

  it('取消已开始的查询转换为 AbortError，不刷新会话', async () => {
    reply.delay = true
    const controller = new AbortController()
    const pending = api.musicApi.search('netease', 'cancel', 0, 30, controller.signal)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(received).toHaveLength(1))
    controller.abort()
    await assertion
    expect(refreshSession).not.toHaveBeenCalled()
  })

  it('取消播放解析同样转换为 AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(api.musicApi.playback(track, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(received).toHaveLength(0)
  })

  it('连接中断返回安全网络提示，不暴露 Axios 请求配置', async () => {
    reply.disconnect = true
    await expect(api.likesApi.list()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
      message: '无法连接服务，请检查网络后重试',
    })
    expect(received).toHaveLength(1)
  })

  it.each([
    '<html>error</html>',
    '{"ok":',
    'null',
    '{"ok":true,"requestId":"test"}',
    '{"ok":false,"error":{},"requestId":"test"}',
  ])('无效 JSON 或响应外壳统一提示：%s', async (raw) => {
    reply.raw = raw
    await expect(api.likesApi.list()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: '服务返回的数据格式异常，请稍后重试',
    })
  })

  it('非成功 HTTP 状态不能凭成功外壳当作成功', async () => {
    reply = { status: 500, body: { ok: true, data: null, requestId: 'test' } }
    await expect(api.likesApi.clear()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 500,
    })
  })
})
