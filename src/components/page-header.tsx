import styles from '@/components/page-header.module.css'
import type { ReactNode } from 'react'

/** 统一上方蓝色英文小字、下方黑色中文标题及页面操作入口。 */
export function PageHeader({
  name,
  title,
  children,
}: {
  name: string
  title: string
  children?: ReactNode
}) {
  return (
    <header className={styles.pageHeading}>
      <h1 className={styles.headingTitle}>
        <span className={styles.pageName}>{name}</span>
        <span className={styles.pageTitle}>{title}</span>
      </h1>
      {children && <div className={styles.pageHeadingActions}>{children}</div>}
    </header>
  )
}
