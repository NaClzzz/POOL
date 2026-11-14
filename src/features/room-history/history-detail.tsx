'use client'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { useRoomHistoryDetail } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { ErrorState, Loading } from '@/components/feedback'
import { formatDate, cn } from '@/lib/utils'
import shared from '@/components/presentation.module.css'
import styles from './history-pages.module.css'

/** 真实房间归档只展示已落库资料，AI 尚未接入时不调用模拟生成器。 */
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
            <div className={shared.emptyState}>
              <h3 className={shared.emptyTitle}>尚未接入</h3>
              {query.data.status === 'active' && (
                <Button
                  nativeButton={false}
                  render={<Link href={`/rooms/${query.data.roomCode}`} />}
                >
                  返回房间
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
