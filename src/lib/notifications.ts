import { toast } from '@/components/ui/toast'

/** 短暂成功反馈统一停留三秒；复杂操作可补充结果统计。 */
export function notifySuccess(title: string, description?: string) {
  toast.add({ title, description, type: 'success', timeout: 3000 })
}

/** 操作失败统一停留五秒；取消静默，限流保留等待时间。 */
export function notifyError(error: Error) {
  if (error.name === 'AbortError') return
  const retryAfter = 'retryAfter' in error ? error.retryAfter : null
  toast.add({
    title: error.message,
    description:
      typeof retryAfter === 'number' && retryAfter > 0 ? `请在 ${retryAfter} 秒后重试` : undefined,
    type: 'error',
    timeout: 5000,
  })
}
