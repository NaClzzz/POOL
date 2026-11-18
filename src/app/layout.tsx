import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Providers } from '@/components/providers'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'POOL', template: '%s · POOL' },
  description: '搜索与收藏音乐，在房间里一起听歌、聊天，生成歌单赏析与房间回顾。',
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
