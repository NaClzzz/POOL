import { createHash } from 'node:crypto'
import { getRedis } from '../redis'
import { BusinessError } from '../http/errors'

/** Web 单实例共享并发资格；任务结束即释放，不排队也不占用日额度。 */
const globalState = globalThis as typeof globalThis & { poolAiTasks?: Set<string> }
const tasks = (globalState.poolAiTasks ??= new Set<string>())

/** 保证同用户分析／同房总结唯一，并限制全站十个任务。 */
export function acquireAiTask(key: string) {
  if (tasks.has(key)) throw new BusinessError('AI_IN_PROGRESS', '已有生成任务正在进行', 409)
  if (tasks.size >= 10) throw new BusinessError('AI_BUSY', '当前生成任务较多，请稍后重试', 503)
  tasks.add(key)
  return () => {
    tasks.delete(key)
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

/** 临近模型启动才扣触发用户额度；两类 AI 功能独立，Redis 故障关闭入口。 */
export async function chargeAiQuota(userId: string, kind: 'playlist' | 'summary') {
  const id = createHash('sha256').update(userId).digest('hex')
  const prefix = `${process.env.POOL_AI_NAMESPACE || 'pool:ai:v1'}:${kind}:${id}`
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
