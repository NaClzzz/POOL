import { createHash } from 'node:crypto'
import { getRedis } from '../redis'
import { BusinessError } from '../http/errors'

/** Web 单实例全站并发计数；同房互斥由数据库事务保证。 */
const globalState = globalThis as typeof globalThis & { poolAiActive?: number }
const MAX_CONCURRENT_TASKS = 10

/** 全站最多十个总结任务并发；任务结束即释放，不排队。 */
export function acquireAiTask() {
  const active = globalState.poolAiActive ?? 0
  if (active >= MAX_CONCURRENT_TASKS)
    throw new BusinessError('AI_BUSY', '当前生成任务较多，请稍后重试', 503)
  globalState.poolAiActive = active + 1
  let released = false
  return () => {
    if (released) return
    released = true
    globalState.poolAiActive = Math.max(0, (globalState.poolAiActive ?? 1) - 1)
  }
}

/** 两种额度同时检查通过后才增加，拒绝请求不会耗尽另一项额度。 */
const quotaScript = `
local minute=tonumber(redis.call('GET',KEYS[1]) or '0')
local day=tonumber(redis.call('GET',KEYS[2]) or '0')
if minute>=1 or day>=10 then
  local wait=0
  if minute>=1 then wait=math.max(wait,redis.call('TTL',KEYS[1])) end
  if day>=10 then wait=math.max(wait,redis.call('TTL',KEYS[2])) end
  return {0,wait}
end
redis.call('INCR',KEYS[1]); if minute==0 then redis.call('EXPIRE',KEYS[1],60) end
redis.call('INCR',KEYS[2]); if day==0 then redis.call('EXPIRE',KEYS[2],86400) end
return {1,0}`

/** 临近模型启动才扣触发用户的跨房额度；Redis 故障关闭入口。 */
export async function chargeAiQuota(userId: string) {
  const id = createHash('sha256').update(userId).digest('hex')
  const prefix = `${process.env.POOL_AI_NAMESPACE || 'pool:ai:v1'}:summary:${id}`
  let result: [number, number]
  try {
    result = (await (
      await getRedis()
    ).eval(quotaScript, {
      keys: [`${prefix}:minute`, `${prefix}:day`],
      arguments: [],
    })) as [number, number]
  } catch {
    throw new BusinessError('LIMITER_UNAVAILABLE', 'AI 限流服务暂时不可用，请稍后重试', 503)
  }
  if (!result[0])
    throw new BusinessError(
      'RATE_LIMITED',
      '生成次数已达上限，请稍后再试',
      429,
      Math.max(1, result[1]),
    )
}
