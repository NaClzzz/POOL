import { createHash } from 'node:crypto'
import { createClient } from 'redis'
import { readServerEnv } from '../env'

/** 登录／注册限流使用 Redis；用户与会话仍由 PostgreSQL 保存。 */
const redisGlobal = globalThis as typeof globalThis & {
  poolAuthRedis?: ReturnType<typeof createClient>
  poolAuthRedisConnecting?: Promise<unknown>
}

export const authRedis =
  redisGlobal.poolAuthRedis ??
  createClient({
    url: readServerEnv().REDIS_URL,
    disableOfflineQueue: true,
    socket: { connectTimeout: 3000, reconnectStrategy: false },
  })
if (!redisGlobal.poolAuthRedis) {
  authRedis.on('error', () => console.error('[auth] Redis 连接不可用'))
  redisGlobal.poolAuthRedis = authRedis
}

/** 固定窗口内的计数与过期设置在一次 Lua 调用中原子执行。 */
const consumeScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('TTL', KEYS[1])}
`

/** Redis 故障标记供认证 HTTP 入口映射 503，不降级为无限制登录。 */
export class AuthLimiterUnavailable extends Error {
  constructor() {
    super('账号服务暂时不可用，请稍后重试')
  }
}

/** 向 Better Auth 提供原子消费接口，不在 Redis key 中保存明文邮箱或 IP。 */
export const authRateLimitStorage = {
  async consume(key: string, rule: { window: number; max: number }) {
    try {
      if (!authRedis.isReady) {
        redisGlobal.poolAuthRedisConnecting ??= authRedis.connect().finally(() => {
          redisGlobal.poolAuthRedisConnecting = undefined
        })
        await redisGlobal.poolAuthRedisConnecting
      }
      const hashedKey = createHash('sha256').update(key).digest('hex')
      const [count, ttl] = (await authRedis.eval(consumeScript, {
        keys: [`${process.env.POOL_AUTH_RATE_NAMESPACE || 'pool:auth:rate'}:${hashedKey}`],
        arguments: [String(rule.window)],
      })) as [number, number]
      return { allowed: count <= rule.max, retryAfter: count > rule.max ? Math.max(1, ttl) : null }
    } catch {
      throw new AuthLimiterUnavailable()
    }
  },
}
