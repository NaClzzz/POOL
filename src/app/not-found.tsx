import { cn } from '@/lib/utils'
import styles from '@/components/presentation.module.css'
import Link from 'next/link'

/** 提供站内无效链接的返回入口。 */
export default function NotFound() {
  return (
    <div className={styles.bootScreen}>
      <div className={styles.emptyState}>
        <h1 className={styles.emptyTitle}>页面不存在</h1>
        <Link href="/search" className={cn('text-primary', styles.link)}>
          返回搜索
        </Link>
      </div>
    </div>
  )
}
