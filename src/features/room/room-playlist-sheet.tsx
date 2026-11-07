'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Shuffle, Trash2, Upload } from 'lucide-react'
import type { RoomSnapshot, Track } from '@/contracts/domain'
import { api } from '@/mocks/api'
import { SortableQueue } from '@/features/music/sortable-queue'
import { TrackList } from '@/features/music/track-list'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Empty, ErrorState, Loading } from '@/components/feedback'
import { cn } from '@/lib/utils'
import sharedStyles from '@/components/presentation.module.css'
import styles from './room-playlist-sheet.module.css'

/** 双列抽屉只展示本人的房间歌单，修改仍通过房间页的统一命令入口。 */
type RoomPlaylistSheetProps = {
  snapshot: RoomSnapshot
  open: boolean
  error: string
  onAdd: (track: Track) => void
  onMove: (track: Track, toIndex: number) => void
  onRemove: (track: Track) => void
  onAction: (action: 'import' | 'shuffle' | 'clear') => void
}

/** 左列搜索加歌、右列管理歌单；两个内容区域独立滚动。 */
export function RoomPlaylistSheet({
  snapshot,
  open,
  error,
  onAdd,
  onMove,
  onRemove,
  onAction,
}: RoomPlaylistSheetProps) {
  const [search, setSearch] = useState('')
  const [source, setSource] = useState('netease')
  const results = useQuery({
    queryKey: ['music', 'room-search', source, search],
    queryFn: ({ signal }) => api.search(source, search, signal),
    enabled: open,
  })
  const disconnected = snapshot.connection !== 'joined'
  return (
    <SheetContent className={styles.sheet} aria-describedby={undefined}>
      <SheetHeader>
        <SheetTitle>我的房间歌单</SheetTitle>
      </SheetHeader>
      {error && <p className={cn(sharedStyles.inlineError, styles.error)}>{error}</p>}
      <div className={styles.columns}>
        <section className={styles.column} aria-label="房间内搜歌">
          <div className={styles.columnHeader}>
            <h3 className={styles.columnTitle}>房间内搜歌</h3>
            <div className={styles.searchControls}>
              <Select
                value={source}
                onValueChange={(value) => value && setSource(value)}
                items={[
                  { value: 'netease', label: '网易云' },
                  { value: 'bilibili', label: 'Bilibili' },
                ]}
              >
                <SelectTrigger className={styles.source} aria-label="房间搜索音源">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectItem value="netease">网易云</SelectItem>
                  <SelectItem value="bilibili">Bilibili</SelectItem>
                </SelectContent>
              </Select>
              <div className={cn(sharedStyles.smallSearch, styles.searchInput)}>
                <Search size={15} />
                <Input
                  variant="embedded"
                  density="compact"
                  aria-label="房间内搜索歌曲"
                  placeholder="搜索歌曲或作者"
                  value={search}
                  maxLength={80}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>
          </div>
          <div className={styles.scrollArea}>
            {results.isPending ? (
              <Loading />
            ) : results.isError ? (
              <ErrorState error={results.error} retry={() => void results.refetch()} />
            ) : results.data.length ? (
              <TrackList tracks={results.data} compact onAdd={onAdd} disabled={disconnected} />
            ) : (
              <Empty title="没有找到歌曲" />
            )}
          </div>
        </section>
        <section className={styles.column} aria-label="我的房间歌单管理">
          <div className={styles.columnHeader}>
            <h3 className={styles.columnTitle}>房间歌单 · {snapshot.myPlaylist.length}/500</h3>
            <div className={styles.actions}>
              <Button
                variant="outline"
                size="sm"
                disabled={disconnected}
                onClick={() => onAction('import')}
              >
                <Upload />
                导入喜欢
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={disconnected || snapshot.myPlaylist.length < 2}
                onClick={() => onAction('shuffle')}
              >
                <Shuffle />
                打乱
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={disconnected || !snapshot.myPlaylist.length}
                onClick={() => onAction('clear')}
              >
                <Trash2 />
                清空
              </Button>
            </div>
          </div>
          <div className={styles.scrollArea}>
            {snapshot.myPlaylist.length ? (
              <SortableQueue
                tracks={snapshot.myPlaylist}
                disabled={disconnected}
                onMove={onMove}
                onRemove={onRemove}
              />
            ) : (
              <Empty title="房间歌单为空" />
            )}
          </div>
        </section>
      </div>
    </SheetContent>
  )
}
