'use client'
import { cn } from '@/lib/utils'

import styles from '@/features/room/lobby-page.module.css'
import sharedStyles from '@/components/presentation.module.css'
import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { ArrowUpRight, Clock3, LockKeyhole, Search, Users } from 'lucide-react'
import { useRooms } from './api'
import { useSession } from '@/stores/session'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Empty, ErrorState, Loading } from '@/components/feedback'
import { PageHeader } from '@/components/page-header'
import { CreateRoomDialog } from './room-create-dialog'

/** 房间大厅与创建入口，列表查询不维护实时房间快照。 */
export function LobbyPage() {
  const [q, setQ] = useState('')
  const [input, setInput] = useState('')
  const user = useSession((s) => s.user!)
  const query = useRooms(q)
  const rooms = query.data
    ? [
        ...(query.data.myRoom ? [query.data.myRoom] : []),
        ...query.data.rooms.items.filter((room) => room.roomId !== query.data.myRoom?.roomId),
      ]
    : []
  /** 提交已确认的查询条件，避免每次按键都发起请求。 */
  const search = (e: FormEvent) => {
    e.preventDefault()
    setQ(input)
  }
  return (
    <>
      <PageHeader name="Listen Together" title="一起听">
        <Button variant="outline" render={<Link href="/rooms/history" />} nativeButton={false}>
          <Clock3 />
          房间历史
        </Button>
        <CreateRoomDialog />
      </PageHeader>
      <div className={sharedStyles.pageToolbar}>
        <form className={cn(sharedStyles.smallSearch, styles.roomSearch)} onSubmit={search}>
          <Search size={16} />
          <Input
            variant="embedded"
            density="compact"
            aria-label="搜索房间"
            placeholder="搜索房间名、标签或房间号"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </form>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !rooms.length ? (
        <Empty title="暂无匹配房间" />
      ) : (
        <div className={styles.roomGrid}>
          {rooms.map((room) => (
            <Link
              className={cn(styles.roomCard, sharedStyles.link)}
              href={`/rooms/${room.roomCode}`}
              key={room.roomId}
            >
              <div className={styles.roomCardHeading}>
                <span className={styles.roomTag}>{room.tag}</span>
                <span className={styles.roomOnline}>{room.memberCount} 人在听</span>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h2 className={styles.roomTitle}>{room.name}</h2>
                  {room.isPasswordProtected ? (
                    <LockKeyhole size={15} className="text-muted-foreground" />
                  ) : (
                    <ArrowUpRight size={18} className="text-primary" />
                  )}
                </div>
                <div className={styles.roomCardMeta}>
                  <span className={styles.roomMetaItem}>
                    <span className={styles.miniAvatar}>{room.ownerName.slice(0, 1)}</span>
                    {room.ownerId === user.id ? '我的房间' : room.ownerName}
                  </span>
                  <span className={styles.roomMetaItem}>
                    <Users size={14} />
                    {room.memberCount} / {room.maxMembers}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
