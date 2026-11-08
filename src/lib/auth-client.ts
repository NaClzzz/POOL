'use client'
import { createAuthClient } from 'better-auth/react'

/** 同域 Cookie 认证客户端；会话只由服务端管理，不保存浏览器认证令牌。 */
export const authClient = createAuthClient({
  sessionOptions: { refetchOnWindowFocus: true, refetchInterval: 60 },
})

/** 把认证库和网络错误转为表单反馈，保留未分类错误的安全提示。 */
export function authErrorMessage(error: { code?: string; status?: number }) {
  if (error.status === 429) return '操作过于频繁，请稍后重试'
  if (error.status === 503 || error.status === 500) return '账号服务暂时不可用，请稍后重试'
  const messages: Record<string, string> = {
    USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: '此邮箱已注册，请直接登录',
    USER_ALREADY_EXISTS: '此邮箱已注册，请直接登录',
    INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不正确',
    INVALID_PASSWORD: '当前密码不正确',
    PASSWORD_TOO_SHORT: '密码至少 8 位',
    PASSWORD_TOO_LONG: '密码最多 128 位',
    INVALID_NAME: '昵称需要 1～30 个字符',
    UNAUTHORIZED: '登录已失效，请重新登录',
    SESSION_EXPIRED: '登录已失效，请重新登录',
  }
  return messages[error.code || ''] || '请求失败，请稍后重试'
}
