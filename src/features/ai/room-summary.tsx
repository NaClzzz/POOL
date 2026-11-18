'use client'
import { Feather, LoaderCircle, RotateCcw } from 'lucide-react'
import { useRoomSummary, useRoomSummaryGeneration } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { ErrorState, Loading } from '@/components/feedback'
import styles from './room-summary.module.css'

/** 共享总结按持久状态确认成功；离页只关闭接收，不停止服务端任务。 */
export function RoomSummary({ roomId }: { roomId: string }) {
  const generation = useRoomSummaryGeneration(roomId)
  const query = useRoomSummary(roomId, generation.pending)
  if (query.isPending) return <Loading />
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const saved = query.data.status === 'succeeded'
  const working = generation.pending || query.data.status === 'generating'
  const content = saved ? query.data.content : generation.text
  const retry = query.data.status === 'failed' || !!generation.error
  return (
    <section aria-label="房间总结" aria-busy={working}>
      {content && <div className={styles.generatedCopy}>{content}</div>}
      {working && (
        <p role="status" className={styles.generationStatus}>
          <LoaderCircle className="size-4 animate-spin" />
          正在生成房间总结…
        </p>
      )}
      {!working && !saved && (
        <Button onClick={generation.generate}>
          {retry ? <RotateCcw /> : <Feather />}
          {retry ? '重试生成' : '生成房间总结'}
        </Button>
      )}
    </section>
  )
}
