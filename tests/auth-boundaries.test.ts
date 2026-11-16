import { describe, expect, it, afterEach } from 'vitest'
import { authReturnTo } from '@/lib/auth-redirect'
import { projectAccountSession, useSession } from '@/stores/session'

afterEach(() => projectAccountSession(null))

describe('真实账号边界', () => {
  it.each([null, 'https://evil.example', '//evil.example', '/\\evil.example', '/\nevil.example'])(
    '拒绝危险回跳路径 %s',
    (target) => {
      expect(authReturnTo(target)).toBe('/search')
    },
  )
  it('保留有效站内回跳地址及查询参数', () => {
    expect(authReturnTo('/rooms/pool-slow')).toBe('/rooms/pool-slow')
    expect(authReturnTo('/search?q=风&source=netease')).toBe('/search?q=风&source=netease')
  })
  it('退出后移除真实账号投影，不保留原账号身份', () => {
    projectAccountSession({ id: 'a', email: 'a@example.com', name: 'A' })
    expect(useSession.getState().user?.id).toBe('a')
    projectAccountSession(null)
    expect(useSession.getState().user).toBeNull()
    expect(useSession.getState().ready).toBe(true)
  })
})
