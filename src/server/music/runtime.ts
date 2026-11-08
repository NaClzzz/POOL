import { createHash } from 'node:crypto'
import { getRedis } from '../redis'
import { BusinessError } from '../http/errors'

/** 单实例上游预算与查询合并；Redis 故障时仍限制真实外部请求。 */
const state = globalThis as typeof globalThis & {
  poolMusicRuntime?: {
    starts: number[]
    active: number
    pending: Map<string, Promise<unknown>>
    localLimits: Map<string, { count: number; until: number }>
  }
}
const runtime = (state.poolMusicRuntime ??= {
  starts: [],
  active: 0,
  pending: new Map(),
  localLimits: new Map(),
})

/** 音乐数据缓存与限流使用独立版本空间，集成测试可指定专用前缀。 */
export function musicKey(key: string) {
  return `${process.env.POOL_MUSIC_NAMESPACE || 'pool:music:v1'}:${key}`
}

/** 固定窗口内原子更新计数与 TTL，缓存命中同样扣用户额度。 */
const limitScript = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('TTL',KEYS[1])}`

/** 普通查询在 Redis 不可用时退至单实例计数；批量导入保持关闭。 */
export async function musicLimit(
  userId: string,
  scope: string,
  max: number,
  seconds = 60,
  required = false,
) {
  const key = musicKey(`rate:${createHash('sha256').update(`${userId}:${scope}`).digest('hex')}`)
  let count: number, ttl: number
  try {
    const redis = await getRedis()
    ;[count, ttl] = (await redis.eval(limitScript, {
      keys: [key],
      arguments: [String(seconds)],
    })) as [number, number]
  } catch {
    if (required)
      throw new BusinessError('LIMITER_UNAVAILABLE', '导入服务暂时不可用，请稍后重试', 503)
    const now = Date.now()
    for (const [key, value] of runtime.localLimits)
      if (value.until <= now) runtime.localLimits.delete(key)
    const entry = runtime.localLimits.get(key) ?? { count: 0, until: now + seconds * 1000 }
    count = ++entry.count
    ttl = Math.ceil((entry.until - now) / 1000)
    runtime.localLimits.set(key, entry)
  }
  if (count > max)
    throw new BusinessError('RATE_LIMITED', '请求过于频繁，请稍后重试', 429, Math.max(1, ttl))
}

/** 只缓存成功结果，同一 key 的并发未命中共享一次上游查询。 */
export async function musicCache<T>(
  key: string,
  seconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const cacheKey = musicKey(`cache:${key}`)
  try {
    const cached = await (await getRedis()).get(cacheKey)
    if (cached !== null) return JSON.parse(cached) as T
  } catch {
    /* 缓存故障不阻止普通音乐查询。 */
  }
  const existing = runtime.pending.get(cacheKey)
  if (existing) return existing as Promise<T>
  const task = (async () => {
    const result = await load()
    try {
      await (await getRedis()).set(cacheKey, JSON.stringify(result), { EX: seconds })
    } catch {
      /* 成功查询可在无缓存时返回。 */
    }
    return result
  })()
  runtime.pending.set(cacheKey, task)
  try {
    return await task
  } finally {
    runtime.pending.delete(cacheKey)
  }
}

/** 所有网易云外部请求共用每秒 5 次、并发 3 个的启动预算。 */
export async function withMusicBudget<T>(load: () => Promise<T>) {
  const deadline = Date.now() + 15000
  while (true) {
    const now = Date.now()
    runtime.starts = runtime.starts.filter((time) => now - time < 1000)
    if (runtime.active < 3 && runtime.starts.length < 5) {
      runtime.active++
      runtime.starts.push(now)
      break
    }
    if (now > deadline)
      throw new BusinessError('UPSTREAM_RATE_LIMITED', '音源服务繁忙，请稍后重试', 502, 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    return await load()
  } finally {
    runtime.active--
  }
}
