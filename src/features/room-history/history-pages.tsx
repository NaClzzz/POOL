'use client'
import { cn } from '@/lib/utils'

import styles from '@/features/room-history/history-pages.module.css'
import sharedStyles from '@/components/presentation.module.css'
import Link from 'next/link'
import { useState } from 'react'
import { ArrowLeft, ArrowUpRight, Clock3, Feather, Headphones, Trash2 } from 'lucide-react'
import { useRoomHistory, useDeleteRoomHistory } from '@/features/room/api'
import { formatDate } from '@/lib/utils'
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

/** 本人历史列表，删除只移除本人访问凭证。 */
export function HistoryPage() {
  const [deleting, setDeleting] = useState<string | null>(null)
  const [viewedAt] = useState(Date.now)
  const query = useRoomHistory()
  const remove = useDeleteRoomHistory({ onSuccess: () => setDeleting(null) })
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
                  {room.status === 'active'
                    ? '房间还在进行中'
                    : `${Math.max(0, Math.ceil((Date.parse(room.expiresAt!) - viewedAt) / 86_400_000))} 天后过期`}
                </p>
              </div>
              <div className={styles.historyActions}>
                <span className={styles.historyStatus}>
                  {room.status === 'active' ? <Headphones size={15} /> : <Feather size={15} />}
                  {room.status === 'active' ? '正在一起听' : '房间已结束'}
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
                  {room.status === 'active' ? '进入房间' : '查看记录'}
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
            删除后无法再访问该房间详情，其他参与者的历史不受影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
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

export { HistoryDetail } from './history-detail'
