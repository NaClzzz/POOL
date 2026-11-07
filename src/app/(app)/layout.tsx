import type { ReactNode } from 'react'
import { AppShell } from '@/components/app-shell'

/** 保护业务路由并共享桌面导航。 */
export default function BusinessLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}
