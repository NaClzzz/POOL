'use client'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { useRoomHistoryDetail } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { ErrorState, Loading } from '@/components/feedback'
import { formatDate, cn } from '@/lib/utils'
import shared from '@/components/presentation.module.css'
import styles from './history-pages.module.css'
import { RoomSummary } from '@/features/ai/room-summary'

/** 本人有效历史详情，结束后可生成或查看同一份持久总结。 */
export function HistoryDetail({ roomId }: { roomId: string }) {
  const query = useRoomHistoryDetail(roomId)
  return (
    <>
      <Link href="/rooms/history" className={cn(shared.backLink, shared.link)}>
        <ArrowLeft size={15} />
        返回房间历史
      </Link>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <div className={styles.memoryPage}>
          <div className={styles.memoryHeading}>
            <div>
              <h1 className={styles.memoryTitle}>{query.data.name}</h1>
              <p className={styles.memoryMeta}>
                {query.data.endedAt ? `${formatDate(query.data.endedAt)} · 房间结束` : '房间进行中'}
              </p>
            </div>
          </div>
          <div className={styles.memoryPaper}>
            <h2 className={styles.summaryTitle}>房间总结</h2>
            {query.data.status === 'active' ? (
              <div className={shared.emptyState}>
                <h3 className={shared.emptyTitle}>房间结束后可生成总结</h3>
                <Button
                  nativeButton={false}
                  render={<Link href={`/rooms/${query.data.roomCode}`} />}
                >
                  返回房间
                </Button>
              </div>
            ) : (
              <RoomSummary roomId={roomId} />
            )}
          </div>
        </div>
      )}
    </>
  )
}
