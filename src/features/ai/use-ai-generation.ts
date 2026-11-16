'use client'
import { useChat } from '@ai-sdk/react'
import { useEffect, useMemo } from 'react'
import { useSession } from '@/stores/session'
import { generationTransport } from './transport'

/** 单次分析／总结的 SDK 生命周期；流文字不进入 Query 或持久 store。 */
export function useAiGeneration(api: string, onSettled?: () => void) {
  const userId = useSession((s) => s.user?.id)
  const transport = useMemo(() => generationTransport(api), [api])
  const { messages, status, error, sendMessage, stop, setMessages, clearError } = useChat({
    id: `${userId}:${api}`,
    transport,
    onFinish: onSettled,
    onError: onSettled,
  })
  useEffect(
    () => () => {
      void stop()
    },
    [stop, userId],
  )
  const text = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
  const pending = status === 'submitted' || status === 'streaming'
  /** 不携带上一轮对话，重新生成始终是独立分析。 */
  const generate = () => {
    if (pending) return
    clearError()
    setMessages([])
    void sendMessage({ text: '生成' })
  }
  return { text, pending, error, generate, stop }
}
