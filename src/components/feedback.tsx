'use client'
import styles from '@/components/presentation.module.css'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** 数据区域骨架，避免请求时整个页面布局跳动。 */
export function Loading() {
  return (
    <div className="py-12 text-center text-muted-foreground">
      <LoaderCircle className="mx-auto mb-3 size-6 animate-spin" />
      <p className="text-sm">加载中…</p>
    </div>
  )
}
/** 统一呈现可重试的异步错误。 */
export function ErrorState({ error, retry }: { error: Error | null; retry?: () => void }) {
  return (
    <div className={styles.emptyState}>
      <h3 className={styles.emptyTitle}>加载失败</h3>
      <p className={styles.emptyDescription}>{error?.message}</p>
      {retry && (
        <Button variant="outline" onClick={retry}>
          重试
        </Button>
      )}
    </div>
  )
}
/** 简洁空态，行动入口由页面决定。 */
export function Empty({ title, text }: { title: string; text?: string }) {
  return (
    <div className={styles.emptyState}>
      <h3 className={styles.emptyTitle}>{title}</h3>
      {text && <p className={styles.emptyDescription}>{text}</p>}
    </div>
  )
}
