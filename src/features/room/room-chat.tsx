'use client'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Send } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { useSession } from '@/stores/session'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/contracts/room'
import type { RoomCommand } from './room-participants'
import styles from './room-page.module.css'
import shared from '@/components/presentation.module.css'

/** 聊天草稿留在本组件，成功确认后才清空，失败不自动重发。 */
export function RoomChat({
  messages,
  connected,
  command,
}: {
  messages: ChatMessage[]
  connected: boolean
  command: RoomCommand
}) {
  const userId = useSession((s) => s.user!.id),
    container = useRef<HTMLDivElement>(null)
  const [message, setMessage] = useState(''),
    [pending, setPending] = useState(false)
  const nearBottom = useRef(true)
  const [hasUnread, setHasUnread] = useState(false)
  const lastMessageId = messages.at(-1)?.id
  useEffect(() => {
    const node = container.current
    if (nearBottom.current) node?.scrollTo({ top: node.scrollHeight })
    else setHasUnread(true)
  }, [lastMessageId])
  /** 单次提交避免 Enter 和按钮重复发送。 */
  const send = async (event: FormEvent) => {
    event.preventDefault()
    if (pending || !message.trim() || Array.from(message.trim()).length > 120) return
    setPending(true)
    const sent = message
    if (await command('room:chat:send', { content: sent }))
      setMessage((current) => (current === sent ? '' : current))
    setPending(false)
  }
  return (
    <aside className={styles.chatPanel}>
      <div className={styles.chatHeader}>
        <h2 className={styles.chatTitle}>聊天</h2>
        {hasUnread && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              container.current?.scrollTo({ top: container.current.scrollHeight })
              nearBottom.current = true
              setHasUnread(false)
            }}
          >
            新消息
          </Button>
        )}
        {connected && <span className={shared.liveDot} />}
      </div>
      <div
        className={styles.chatMessages}
        ref={container}
        onScroll={(event) => {
          const node = event.currentTarget
          nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
          if (nearBottom.current) setHasUnread(false)
        }}
      >
        {messages.map((m) => (
          <div key={m.id} className={cn(styles.chatMessage, m.senderId === userId && styles.self)}>
            <span className={cn(shared.avatar, shared.avatarXs)}>{m.senderName.slice(0, 1)}</span>
            <div className={styles.chatBody}>
              <span className={styles.chatAuthor}>
                {m.senderName}
                <time className={styles.chatTime}>
                  {new Date(m.createdAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </span>
              <p className={styles.chatBubble}>{m.content}</p>
            </div>
          </div>
        ))}
      </div>
      <form className={styles.chatForm} onSubmit={(e) => void send(e)}>
        <Textarea
          variant="chat"
          className={styles.chatInput}
          aria-label="聊天消息"
          placeholder="输入消息"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) void send(e)
          }}
        />
        <div className={styles.chatActions}>
          <span className={styles.chatCount}>{Array.from(message).length}/120</span>
          <Button
            type="submit"
            size="sm"
            disabled={
              !connected || pending || !message.trim() || Array.from(message.trim()).length > 120
            }
          >
            发送
          </Button>
        </div>
      </form>
    </aside>
  )
}
