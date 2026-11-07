import { create } from 'zustand'
import { getSession } from '@/mocks/api'
import type { DemoUser } from '@/contracts/domain'

/** 模拟会话的界面投影，真实认证接入时替换实现。 */
type SessionState = {
  user: DemoUser | null
  ready: boolean
  restore: () => void
  setUser: (user: DemoUser | null) => void
}
/** 统一恢复身份，避免每个页面各读一份 sessionStorage。 */
export const useSession = create<SessionState>((set) => ({
  user: null,
  ready: false,
  restore: () => set({ user: getSession(), ready: true }),
  setUser: (user) => set({ user, ready: true }),
}))
