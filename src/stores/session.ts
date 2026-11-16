import { create } from 'zustand'
import type { AccountUser } from '@/contracts/auth'

/** Better Auth 会话的只读安全投影，不负责登录、签发或持久化身份。 */
type SessionState = {
  user: AccountUser | null
  ready: boolean
  error: string | null
}

/** 兼容现有页面的选择器，会话权威来源始终为认证客户端与服务端。 */
export const useSession = create<SessionState>(() => ({ user: null, ready: false, error: null }))

/** 仅由会话同步边界或成功退出更新真实身份投影。 */
export function projectAccountSession(user: AccountUser | null, error: string | null = null) {
  useSession.setState({ user, ready: true, error })
}
