import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Providers } from '@/components/providers'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'POOL', template: '%s · POOL' },
  description: '音乐搜索、收藏与一起听的桌面端交互原型。',
}

/** 根布局只提供样式、查询容器和个人音频的常驻边界。 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
