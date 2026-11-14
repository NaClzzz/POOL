import type { AccountUser } from '@/contracts/auth'
import type { DemoScenario, Track } from '@/contracts/domain'
import { analysisText } from './fixtures'

const KEY = 'pool:ai-demo:v1'
let scenario: DemoScenario = 'normal'
let session: AccountUser | null = null
let generation = 0
const running = new Set<string>()
/** 剩余 mock 只维护歌单分析演示，不读写真实账号、房间或收藏。 */
export function getDatabase() {
  if (typeof window !== 'undefined') {
    const saved = window.localStorage.getItem(KEY)
    if (['normal', 'slow', 'offline', 'limited', 'ai-fail'].includes(saved ?? ''))
      scenario = saved as DemoScenario
  }
  return { scenario }
}
/** 安全账号投影仅用于 AI 演示任务归属，不用于真实鉴权。 */
export function setMockUser(user: AccountUser | null) {
  session = user
}
/** 未登录不能开始演示生成。 */
export function requireUser() {
  if (!session) throw new Error('请先登录')
  return session
}
/** 演示场景独立命名空间，不迁移旧房间资料。 */
export function setScenario(value: DemoScenario) {
  scenario = value
  if (typeof window !== 'undefined') window.localStorage.setItem(KEY, value)
}
/** 重置只取消旧 AI 演示任务和恢复场景。 */
export function resetDemo() {
  generation++
  setScenario('normal')
}
/** 可取消演示延迟，所有完成路径移除取消监听。 */
export function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, ms)
    const cancel = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      reject(new DOMException('已取消', 'AbortError'))
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}
/** 固定文本只模拟歌单分析分段输出，真实房间总结不调用这里。 */
export async function generateText(
  onText: (text: string) => void,
  signal: AbortSignal,
  tracks?: Track[],
) {
  const user = requireUser(),
    epoch = generation
  if (!tracks?.length) throw new Error('请先添加喜欢的歌曲')
  if (running.has(user.id)) throw new Error('正在生成，请等待当前请求完成')
  if (running.size >= 10) throw new Error('当前生成名额已满，请稍后重试')
  running.add(user.id)
  try {
    await wait(
      process.env.NODE_ENV === 'test' ? 0 : getDatabase().scenario === 'slow' ? 1500 : 550,
      signal,
    )
    if (['offline', 'limited', 'ai-fail'].includes(scenario))
      throw new Error('生成暂时失败，请稍后手动重试')
    for (let i = 0; i < analysisText.length; i += 8) {
      await wait(process.env.NODE_ENV === 'test' ? 0 : 45, signal)
      if (session?.id !== user.id || epoch !== generation)
        throw new DOMException('演示已重置或账号已切换', 'AbortError')
      onText(analysisText.slice(0, i + 8))
    }
  } finally {
    running.delete(user.id)
  }
}
