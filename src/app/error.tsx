'use client'
import styles from '@/components/presentation.module.css'
import { Button } from '@/components/ui/button'

/** 捕获渲染异常并提供用户主动重试入口。 */
export default function PageError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className={styles.emptyState}>
      <h2 className={styles.emptyTitle}>页面加载失败</h2>
      <Button onClick={reset}>重新加载</Button>
    </div>
  )
}
