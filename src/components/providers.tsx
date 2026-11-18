'use client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { AccountSessionProvider } from '@/features/auth/session-provider'
import { PLAYER_VOLUME_KEY, usePlayer } from '@/stores/player'
import { PersonalAudio } from '@/features/player/audio'

/** 应用级查询容器与个人音频生命周期，房间不在这里建立连接。 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: 20_000, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      }),
  )
  useEffect(() => {
    const volume = localStorage.getItem(PLAYER_VOLUME_KEY)
    if (volume) usePlayer.setState({ volume: Number(volume) })
  }, [])
  return (
    <QueryClientProvider client={client}>
      <AccountSessionProvider>
        {children}
        <PersonalAudio />
      </AccountSessionProvider>
    </QueryClientProvider>
  )
}
