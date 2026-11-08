import { create } from 'zustand'
import { setMockUser } from '@/mocks/api'
import type { AccountUser } from '@/contracts/auth'

/** Better Auth 会话的只读安全投影，不负责登录、签发或持久化身份。 */
type SessionState = {
  user: AccountUser | null
  ready: boolean
  error: string | null
}

/** 兼容现有页面的选择器，会话权威来源始终为认证客户端与服务端。 */
export const useSession = create<SessionState>(() => ({ user: null, ready: false, error: null }))

/** 仅由会话同步边界或成功退出更新投影，同时隔离仍使用 mock 的业务资料。 */
export function projectAccountSession(user: AccountUser | null, error: string | null = null) {
  setMockUser(user)
  useSession.setState({ user, ready: true, error })
}
