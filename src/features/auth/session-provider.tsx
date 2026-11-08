'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'
import { projectAccountSession, useSession } from '@/stores/session'
import { usePlayer } from '@/stores/player'
import { Loading } from '@/components/feedback'
import { Button } from '@/components/ui/button'
import styles from '@/components/presentation.module.css'

/** 将认证客户端结果投影到现有页面；换号时先停止音频并清理私有请求。 */
export function AccountSessionProvider({ children }: { children: ReactNode }) {
  const { data, isPending, error, refetch } = authClient.useSession()
  const client = useQueryClient()
  const projected = useSession()
  const previousId = useRef<string | null>(null)
  const user = error ? null : data?.user
  const id = user?.id ?? null
  const email = user?.email ?? ''
  const name = user?.name ?? ''

  useEffect(() => {
    // 旧版 sessionStorage 不能参与真实认证；仅移除该明确的原型键。
    sessionStorage.removeItem('pool:prototype:v1:session')
  }, [])

  useEffect(() => {
    if (isPending) return
    if (previousId.current !== id || error) {
      void client.cancelQueries()
      client.clear()
      usePlayer.getState().reset()
    }
    previousId.current = id
    projectAccountSession(id ? { id, email, name } : null, error ? '无法读取账号会话' : null)
  }, [id, email, name, isPending, error, client])

  if (error) {
    return (
      <div className={styles.bootScreen}>
        <div className={styles.emptyState}>
          <h2 className={styles.emptyTitle}>无法连接账号服务</h2>
          <Button variant="outline" onClick={() => void refetch()}>
            重试
          </Button>
        </div>
      </div>
    )
  }
  if (isPending || !projected.ready || projected.user?.id !== user?.id) return <Loading />
  return children
}
