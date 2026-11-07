// 来源：shadcn/ui 官方 Base Nova registry；仅调整项目主题、尺寸和中文可访问名称。
'use client'

import * as React from 'react'
import { Input as InputPrimitive } from '@base-ui/react/input'
import { cn } from '@/lib/utils'
import styles from './input.module.css'

/** 标准文本输入，保留 Base UI 的表单和焦点语义。 */
function Input({
  className,
  type,
  variant = 'default',
  density = 'default',
  ...props
}: React.ComponentProps<'input'> & {
  /** 组合搜索框复用透明输入外观，避免业务 CSS 覆盖控件。 */
  variant?: 'default' | 'embedded'
  /** 紧凑输入用于大厅与房间内搜索。 */
  density?: 'default' | 'compact'
}) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-10 w-full min-w-0 rounded-lg border-0 bg-muted px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[#97a2af] disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        variant === 'embedded' && styles.embedded,
        density === 'compact' && styles.compact,
        className,
      )}
      {...props}
    />
  )
}

export { Input }
