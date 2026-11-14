import { describe, expect, it, vi, afterEach } from 'vitest'
import { authReturnTo } from '@/lib/auth-redirect'
import { generateText, resetDemo, setMockUser, requireUser } from '@/mocks/api'
import { catalog } from './fixtures/tracks'

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

  it('未登录不能开始演示，真实身份只作为任务归属', () => {
    resetDemo()
    setMockUser({ id: 'real-auth-id', email: 'demo@pool.local', name: '真实账号' })
    expect(requireUser().id).toBe('real-auth-id')
    setMockUser(null)
    expect(requireUser).toThrow('请先登录')
  })

  it('账号切换取消旧 AI 演示，不输出给新账号', async () => {
    resetDemo()
    setMockUser({ id: 'a', email: 'a@example.com', name: 'A' })
    const output = vi.fn()
    const operation = generateText(output, new AbortController().signal, catalog)
    const assertion = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    setMockUser({ id: 'b', email: 'b@example.com', name: 'B' })
    await assertion
    expect(output).not.toHaveBeenCalled()
  })
})
