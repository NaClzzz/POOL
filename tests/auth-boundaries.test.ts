import { describe, expect, it, vi, afterEach } from 'vitest'
import { authReturnTo } from '@/lib/auth-redirect'
import { api, resetDemo, setMockUser, setScenario, requireUser } from '@/mocks/api'
import { catalog } from '@/mocks/fixtures'

afterEach(() => {
  setMockUser(null)
  vi.useRealTimers()
})

describe('真实账号与 mock 过渡边界', () => {
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

  it('真实主键身份不会继承相同邮箱下的演示资料', async () => {
    resetDemo()
    setMockUser({ id: 'real-auth-id', email: 'demo@pool.local', name: '真实账号' })
    expect(await api.likes()).toEqual([])
    expect(await api.history()).toEqual([])
    setMockUser(null)
    expect(requireUser).toThrow('请先登录')
  })

  it('账号切换后取消旧身份的延迟操作，不把收藏写入新账号', async () => {
    resetDemo()
    vi.useFakeTimers()
    setScenario('slow')
    setMockUser({ id: 'user-a', email: 'same@example.com', name: 'A' })
    const operation = api.addLike(catalog[0])
    const assertion = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    setMockUser({ id: 'user-b', email: 'same@example.com', name: 'B' })
    await vi.runAllTimersAsync()
    await assertion
    vi.useRealTimers()
    setScenario('normal')
    expect(await api.likes()).toEqual([])
  })
})
