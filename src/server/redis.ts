import { createClient } from 'redis'
import { readServerEnv } from './env'

/** Web 单实例共享 Redis 连接，热更新不会创建多套客户端。 */
const shared = globalThis as typeof globalThis & {
  poolRedis?: ReturnType<typeof createClient>
  poolRedisConnecting?: Promise<unknown>
}
export const redis =
  shared.poolRedis ??
  createClient({
    url: readServerEnv().REDIS_URL,
    disableOfflineQueue: true,
    socket: { connectTimeout: 3000, reconnectStrategy: false },
  })
if (!shared.poolRedis) {
  redis.on('error', () => console.error('[redis] 连接不可用'))
  shared.poolRedis = redis
}

/** 首次使用或断开后重新连接；同一时刻只执行一次连接。 */
export async function getRedis() {
  if (!redis.isReady) {
    shared.poolRedisConnecting ??= redis.connect().finally(() => {
      shared.poolRedisConnecting = undefined
    })
    await shared.poolRedisConnecting
  }
  return redis
}
