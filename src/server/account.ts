import 'server-only'
import { auth } from './auth/core'
import { success, failure } from './http/response'

/** 受保护账号接口只返回当前 Cookie 身份，不接受查询参数指定其他用户。 */
export async function getAccount(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableRefresh: true },
    })
    if (!session) return failure('UNAUTHENTICATED', '请先登录', 401, requestId)
    const { id, name, email, image, emailVerified, createdAt } = session.user
    return success({ id, name, email, image, emailVerified, createdAt }, requestId)
  } catch {
    console.error(`[account] 请求失败 ${requestId}`)
    return failure('INTERNAL_ERROR', '账号服务暂时不可用，请稍后重试', 500, requestId)
  }
}
