import { auth } from './core'
import { readServerEnv } from '../env'
import { AuthLimiterUnavailable } from './rate-limit'

/** 白名单 */
const enabledPaths = new Set([
  '/sign-up/email',
  '/sign-in/email',
  '/get-session',
  '/sign-out',
  '/update-user',
  '/change-password',
])

/** 处理 */
export async function handleAuthRequest(request: Request) {
  const path = new URL(request.url).pathname.replace(/^\/api\/auth/, '')
  if (!enabledPaths.has(path))
    return Response.json({ code: 'NOT_FOUND', message: '接口不存在' }, { status: 404 })
  const headers = new Headers(request.headers)
  const trustProxy = readServerEnv().AUTH_TRUST_PROXY === 'true'
  headers.set(
    'x-pool-client-ip',
    trustProxy ? headers.get('x-forwarded-for')?.split(',')[0].trim() || '127.0.0.1' : '127.0.0.1',
  )
  try {
    // Next.js 运行时的 Request 与原生构造器可能不属于同一实例类型，按 URL 重建而不传实例。
    const response = await auth.handler(
      new Request(request.url, {
        method: request.method,
        headers,
        body:
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : await request.arrayBuffer(),
        signal: request.signal,
      }),
    )
    response.headers.set('Cache-Control', 'no-store')
    const retryAfter = response.headers.get('x-retry-after')
    if (retryAfter) response.headers.set('Retry-After', retryAfter)
    return response
  } catch (error) {
    if (error instanceof AuthLimiterUnavailable) {
      return Response.json(
        { code: 'LIMITER_UNAVAILABLE', message: error.message },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    console.error('[auth] 认证请求失败', error instanceof Error ? error.name : 'UnknownError')
    return Response.json(
      { code: 'INTERNAL_ERROR', message: '账号服务暂时不可用，请稍后重试' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
