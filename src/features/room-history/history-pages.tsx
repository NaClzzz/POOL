'use client'
import { cn } from '@/lib/utils'

import styles from '@/features/room-history/history-pages.module.css'
import sharedStyles from '@/components/presentation.module.css'
import Link from 'next/link'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowUpRight, Clock3, Feather, Headphones, Trash2 } from 'lucide-react'
import { api } from '@/mocks/api'
import { useSession } from '@/stores/session'
import { formatDate } from '@/lib/utils'
import { GenerationPanel } from '@/features/ai/generation-panel'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Empty, ErrorState, Loading } from '@/components/feedback'
import { PageHeader } from '@/components/page-header'

/** 本人历史列表，删除只移除访问凭证而不删除共享总结。 */
export function HistoryPage() {
  const userId = useSession((s) => s.user!.id)
  const client = useQueryClient()
  const [deleting, setDeleting] = useState<string | null>(null)
  const query = useQuery({ queryKey: ['room-history', userId], queryFn: () => api.history() })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteHistory(id),
    onSuccess: async () => {
      setDeleting(null)
      await client.invalidateQueries({ queryKey: ['room-history', userId] })
      client.removeQueries({ queryKey: ['room-summary', userId] })
    },
  })
  return (
    <AlertDialog open={!!deleting} onOpenChange={(value) => !value && setDeleting(null)}>
      <Link href="/rooms" className={cn(sharedStyles.backLink, sharedStyles.link)}>
        <ArrowLeft size={15} />
        一起听大厅
      </Link>
      <PageHeader name="History" title="房间历史">
        <span className={styles.historyCount}>
          <Clock3 size={17} />
          {query.data?.length ?? 0} / 50
        </span>
      </PageHeader>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.length ? (
        <Empty title="暂无房间历史" />
      ) : (
        <div className={styles.historyList}>
          {query.data.map((room) => (
            <article className={styles.historyCard} key={room.roomId}>
              <div className={styles.historyCardBody}>
                <span className={sharedStyles.softTag}>{room.tag}</span>
                <h2 className={styles.historyTitle}>{room.name}</h2>
                <p className={styles.historyMeta}>
                  {formatDate(room.lastJoinedAt)}
                  <span>·</span>
                  {room.status === 'active' ? '房间还在进行中' : '结束后保留 7 天'}
                </p>
              </div>
              <div className={styles.historyActions}>
                <span
                  className={cn(styles.historyStatus, room.summary === 'succeeded' && styles.ready)}
                >
                  {room.status === 'active' ? <Headphones size={15} /> : <Feather size={15} />}
                  {room.status === 'active'
                    ? '正在一起听'
                    : room.summary === 'succeeded'
                      ? '总结已生成'
                      : '总结未生成'}
                </span>
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={
                    <Link
                      href={
                        room.status === 'active'
                          ? `/rooms/${room.roomCode}`
                          : `/rooms/history/${room.roomId}`
                      }
                    />
                  }
                >
                  {room.status === 'active' ? '进入房间' : '查看总结'}
                  <ArrowUpRight />
                </Button>
                <AlertDialogTrigger
                  render={
                    <Button variant="ghost" size="icon" aria-label={`删除历史 ${room.name}`} />
                  }
                  onClick={() => {
                    remove.reset()
                    setDeleting(room.roomId)
                  }}
                >
                  <Trash2 />
                </AlertDialogTrigger>
              </div>
            </article>
          ))}
        </div>
      )}

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除这条房间历史？</AlertDialogTitle>
          <AlertDialogDescription>
            你会失去该房间总结的生成与查看权限。其他参与者的记录与共享总结不受影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.error && <p className={sharedStyles.inlineError}>{remove.error.message}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate(deleting!)}
          >
            删除我的记录
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** 按历史凭证读取归档和唯一总结，成功后不提供删除或重新生成。 */
export function HistoryDetail({ roomId }: { roomId: string }) {
  const userId = useSession((s) => s.user!.id)
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['room-summary', userId, roomId],
    queryFn: () => api.summary(roomId),
    refetchInterval: (state) => (state.state.data?.summary.status === 'generating' ? 1200 : false),
  })
  return (
    <>
      <Link href="/rooms/history" className={cn(sharedStyles.backLink, sharedStyles.link)}>
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
              <h1 className={styles.memoryTitle}>{query.data.room.name}</h1>
              <p className={styles.memoryMeta}>
                {query.data.room.endedAt && formatDate(query.data.room.endedAt)}
                <span>·</span>房间结束时间
              </p>
            </div>
          </div>
          <div className={styles.memoryPaper}>
            <h2 className={styles.summaryTitle}>房间总结</h2>
            {query.data.room.status === 'active' ? (
              <div className={sharedStyles.emptyState}>
                <h3 className={sharedStyles.emptyTitle}>房间尚未结束</h3>
                <p className={sharedStyles.emptyDescription}>结束后可生成总结。</p>
                <Button
                  nativeButton={false}
                  render={<Link href={`/rooms/${query.data.room.roomCode}`} />}
                >
                  返回房间
                </Button>
              </div>
            ) : (
              <GenerationPanel
                key={roomId}
                kind="summary"
                roomId={roomId}
                initial={
                  query.data.summary.status === 'succeeded' ? query.data.summary.content : ''
                }
                onComplete={() => {
                  void client.invalidateQueries({ queryKey: ['room-summary', userId, roomId] })
                  void client.invalidateQueries({ queryKey: ['room-history', userId] })
                }}
              />
            )}
            <div className={styles.memoryPaperBottom}>
              这份总结由所有参与者共同拥有，房间结束满 7 天清理。
            </div>
          </div>
        </div>
      )}
    </>
  )
}
