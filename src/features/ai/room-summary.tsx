'use client'
import { useQueryClient } from '@tanstack/react-query'
import { Feather, LoaderCircle, RotateCcw } from 'lucide-react'
import { useRoomSummary } from '@/lib/api-client'
import { useSession } from '@/stores/session'
import { Button } from '@/components/ui/button'
import { ErrorState, Loading } from '@/components/feedback'
import { useAiGeneration } from './use-ai-generation'
import styles from './generation-panel.module.css'
import shared from '@/components/presentation.module.css'

/** 共享总结按持久状态确认成功；离页只关闭接收，不停止服务端任务。 */
export function RoomSummary({ roomId }: { roomId: string }) {
  const client = useQueryClient()
  const userId = useSession((s) => s.user?.id)
  const key = ['room-summary', userId, roomId]
  const generation = useAiGeneration(`/api/rooms/${encodeURIComponent(roomId)}/summary`, () => {
    void client.invalidateQueries({ queryKey: key })
  })
  const query = useRoomSummary(roomId, true, generation.pending)
  if (query.isPending) return <Loading />
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const saved = query.data.status === 'succeeded'
  const working = generation.pending || query.data.status === 'generating'
  const content = saved ? query.data.content : generation.text
  return (
    <section aria-label="房间总结" aria-busy={working}>
      {content && <div className={styles.generatedCopy}>{content}</div>}
      {working ? (
        <p role="status" className={styles.generationStatus}>
          <LoaderCircle className="size-4 animate-spin" />
          正在生成房间总结…
        </p>
      ) : (
        !saved && (
          <Button onClick={generation.generate}>
            {query.data.status === 'failed' || generation.error ? <RotateCcw /> : <Feather />}
            {query.data.status === 'failed' || generation.error ? '重试生成' : '生成房间总结'}
          </Button>
        )
      )}
      {!saved && generation.error && (
        <p role="alert" className={shared.inlineError}>
          {generation.error.message}
        </p>
      )}
      {!saved && !generation.error && query.data.status === 'failed' && (
        <p role="alert" className={shared.inlineError}>
          上次总结未完成，可以手动重试。
        </p>
      )}
    </section>
  )
}
