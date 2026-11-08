'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { authClient, authErrorMessage } from '@/lib/auth-client'
import { projectAccountSession } from '@/stores/session'
import { usePlayer } from '@/stores/player'

/** 两处退出入口共用真实会话撤销，服务端失败时明确反馈并允许重试。 */
export function useLogout() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()
  const client = useQueryClient()
  const logout = async () => {
    setPending(true)
    setError('')
    try {
      const result = await authClient.signOut()
      if (result.error) {
        setError(authErrorMessage(result.error))
        return
      }
      projectAccountSession(null)
      await client.cancelQueries()
      client.clear()
      usePlayer.getState().reset()
      router.replace('/login')
      router.refresh()
    } catch {
      setError('无法退出账号，请稍后重试')
    } finally {
      setPending(false)
    }
  }
  return { logout, pending, error }
}
