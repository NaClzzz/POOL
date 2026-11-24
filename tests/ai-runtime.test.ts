import { afterEach, describe, expect, it, vi } from 'vitest'
const { evalQuota } = vi.hoisted(() => ({ evalQuota: vi.fn() }))
vi.mock('@/server/redis', () => ({ getRedis: async () => ({ eval: evalQuota }) }))
import { acquireAiTask, chargeAiQuota } from '@/server/ai/runtime'

const releases: (() => void)[] = []
afterEach(() => {
  releases.splice(0).forEach((release) => release())
  vi.clearAllMocks()
})

describe('AI 并发与故障边界', () => {
  it('全站十个名额，满额拒绝，重复释放幂等且释放后可继续使用', () => {
    for (let i = 0; i < 10; i++) releases.push(acquireAiTask())
    expect(() => acquireAiTask()).toThrow('当前生成任务较多')
    const release = releases.pop()!
    release()
    release()
    releases.push(acquireAiTask())
    expect(() => acquireAiTask()).toThrow('当前生成任务较多')
  })
  it('用户额度隔离，拒绝时返回等待秒数', async () => {
    evalQuota.mockResolvedValue([1, 0])
    await chargeAiQuota('a')
    await chargeAiQuota('b')
    const keys = evalQuota.mock.calls.map(([, options]) => options.keys[0])
    expect(new Set(keys).size).toBe(2)
    evalQuota.mockResolvedValue([0, 45])
    await expect(chargeAiQuota('a')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: 45,
    })
  })
  it('Redis 不可用时关闭高成本生成入口', async () => {
    evalQuota.mockRejectedValue(new Error('redis failure'))
    await expect(chargeAiQuota('a')).rejects.toMatchObject({
      code: 'LIMITER_UNAVAILABLE',
      status: 503,
    })
  })
})
