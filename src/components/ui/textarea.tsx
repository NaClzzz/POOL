// 来源：shadcn/ui 官方 Base Nova registry；仅调整项目主题、尺寸和中文可访问名称。
'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import styles from './textarea.module.css'

/** 标准多行输入，统一校验和焦点样式。 */
function Textarea({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'textarea'> & {
  /** 聊天编辑器与外层容器共用底色，并采用紧凑不可缩放外观。 */
  variant?: 'default' | 'chat'
}) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-lg border-0 bg-muted px-2.5 py-2 text-base transition-colors outline-none placeholder:text-[#97a2af] disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        variant === 'chat' && styles.chat,
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
