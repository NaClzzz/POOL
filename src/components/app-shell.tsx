'use client'
import styles from '@/components/app-shell.module.css'
import sharedStyles from '@/components/presentation.module.css'
import { cn } from '@/lib/utils'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { LogOut } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useSession } from '@/stores/session'
import { usePlayer } from '@/stores/player'
import { api } from '@/mocks/api'
import { PersonalPlayerDock } from '@/features/player/player-dock'
import { Loading } from './feedback'

/** 常驻桌面导航与个人播放器，认证成功后才挂载业务页面。 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const isRoomPage = pathname.startsWith('/rooms/pool-')
  const router = useRouter()
  const client = useQueryClient()
  const user = useSession((s) => s.user)
  const ready = useSession((s) => s.ready)
  useEffect(() => {
    if (ready && !user) router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`)
  }, [ready, user, router, pathname])
  /** 退出时同时清除本账号的查询缓存及音频意图。 */
  const logout = () => {
    api.logout()
    useSession.getState().setUser(null)
    usePlayer.getState().reset()
    client.clear()
    router.replace('/login')
  }
  if (!ready || !user)
    return (
      <div className={sharedStyles.bootScreen}>
        <Loading />
      </div>
    )
  return (
    <div className={cn(styles.appShell, isRoomPage && styles.roomShell)}>
      <header className={styles.topbar}>
        <div className={styles.navInner}>
          <Link
            href="/search"
            className={cn(sharedStyles.brand, sharedStyles.link)}
            aria-label="POOL 搜索"
          >
            POOL
          </Link>
          <nav className={styles.nav} aria-label="主导航">
            {[
              ['/search', '搜索'],
              ['/likes', '喜欢'],
              ['/rooms', '一起听'],
              ['/settings', '设置'],
            ].map(([href, title]) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  cn(styles.navLink, pathname.startsWith(href) && styles.active),
                  sharedStyles.link,
                )}
              >
                {title}
              </Link>
            ))}
          </nav>
          <div className={styles.navAccount}>
            <span className={styles.demoChip}>演示模式</span>
            <span className={styles.navDivider} />
            <Link
              href="/settings"
              className={cn(sharedStyles.avatar, sharedStyles.avatarSm, sharedStyles.link)}
              title={user.name}
            >
              {user.name.slice(0, 1)}
            </Link>
            <button
              aria-label="退出登录"
              className={cn(sharedStyles.iconButton, sharedStyles.action)}
              onClick={logout}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </header>
      <main className={cn(styles.page, isRoomPage && styles.roomRoute)}>{children}</main>
      <PersonalPlayerDock />
    </div>
  )
}
