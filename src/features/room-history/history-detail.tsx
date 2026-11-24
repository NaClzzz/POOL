'use client'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { useRoomHistoryDetail } from '@/features/room/api'
import { Button } from '@/components/ui/button'
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from '@/components/ui/avatar'
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
          <header className={styles.memoryHeading}>
            <div className={styles.memoryTitleRow}>
              <h1 className={styles.memoryTitle}>{query.data.name}</h1>
              <span className={shared.softTag}>{query.data.tag}</span>
            </div>
            <div className={styles.memoryDetails}>
              <div className={styles.memoryMeta}>
                {query.data.endedAt ? (
                  <time dateTime={query.data.endedAt}>{formatDate(query.data.endedAt)} 结束</time>
                ) : (
                  <span>房间进行中</span>
                )}
                <AvatarGroup role="group" aria-label="房间参与者">
                  {query.data.participants.slice(0, 8).map((participant) => (
                    <Avatar
                      key={participant.userId}
                      size="sm"
                      title={participant.name}
                      aria-label={participant.name}
                    >
                      {participant.image && <AvatarImage src={participant.image} alt="" />}
                      <AvatarFallback>{participant.name.slice(0, 1)}</AvatarFallback>
                    </Avatar>
                  ))}
                  {query.data.participants.length > 8 && (
                    <AvatarGroupCount
                      title={query.data.participants
                        .slice(8)
                        .map((p) => p.name)
                        .join('、')}
                      aria-label={`另有 ${query.data.participants.length - 8} 位参与者`}
                    >
                      +{query.data.participants.length - 8}
                    </AvatarGroupCount>
                  )}
                </AvatarGroup>
              </div>
              {query.data.expiresAt && (
                <time className={styles.memoryExpiry} dateTime={query.data.expiresAt}>
                  {new Intl.DateTimeFormat('zh-CN', {
                    month: 'long',
                    day: 'numeric',
                  }).format(new Date(query.data.expiresAt))}
                  到期
                </time>
              )}
            </div>
          </header>
          <p className={styles.memoryStats} aria-label="房间互动数据">
            <span>
              参与人数 <strong>{query.data.participants.length}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              播放记录{' '}
              <strong>{query.data.playedCount >= 500 ? '500+' : query.data.playedCount}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              聊天条数{' '}
              <strong>
                {query.data.messageCount >= 10_000 ? '10000+' : query.data.messageCount}
              </strong>
            </span>
          </p>
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
