import { z } from 'zod'
import { auth } from '../auth/core'
import { readServerEnv } from '../env'
import { BusinessError } from './errors'
import { failure, success } from './response'

/** HTTP 业务入口回调取得可信用户 ID，返回普通数据或媒体响应。 */
type Action = (userId: string) => Promise<{ data: unknown; status?: number } | Response>

/** 会话、来源及错误映射集中于单个入口，具体参数由对应路由 schema 校验一次。 */
export async function businessRequest(request: Request, action: Action) {
  const requestId = crypto.randomUUID()
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableRefresh: true },
    })
    if (!session) return failure('UNAUTHENTICATED', '请先登录', 401, requestId)
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.get('origin')
      if (origin && origin !== new URL(readServerEnv().BETTER_AUTH_URL).origin)
        throw new BusinessError('FORBIDDEN', '请求来源不允许', 403)
    }
    const result = await action(session.user.id)
    return result instanceof Response ? result : success(result.data, requestId, result.status)
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return failure('INVALID_INPUT', '请求参数格式不正确', 400, requestId)
    if (error instanceof BusinessError) {
      const response = failure(error.code, error.message, error.status, requestId)
      if (error.retryAfter) response.headers.set('Retry-After', String(error.retryAfter))
      return response
    }
    console.error(
      `[business] 请求失败 ${requestId}`,
      error instanceof Error ? error.name : 'UnknownError',
    )
    return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试', 500, requestId)
  }
}
