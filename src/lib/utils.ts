import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并组件类名并消除冲突的 Tailwind 样式。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
/** 展示毫秒时长，未知值不伪造为零。 */
export function formatTime(ms: number | null) {
  if (ms === null) return '—'
  const s = Math.floor(Math.max(0, ms) / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
/** 格式化业务日期，保持桌面页面内一致。 */
export function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
