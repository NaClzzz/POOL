'use client'

import { useState } from 'react'
import { Search, Shuffle, Trash2, Upload } from 'lucide-react'
import type { RoomPlaylistItem, RoomSnapshot } from '@/contracts/room'
import type { MusicSource } from '@/contracts/domain'
import { useMusicSearch } from '@/features/music/api'
import { useRoomPlaylistActions } from './api'
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

/** 双列抽屉管理本人的房间歌单，写操作通过 HTTP 落库后通知房间同步。 */
type RoomPlaylistSheetProps = {
  snapshot: RoomSnapshot
  open: boolean
  connected: boolean
  onPlaylistUpdated: (items: RoomPlaylistItem[]) => void
}

/** 左列搜索加歌、右列管理歌单；两个内容区域独立滚动。 */
export function RoomPlaylistSheet({
  snapshot,
  open,
  connected,
  onPlaylistUpdated,
}: RoomPlaylistSheetProps) {
  const [search, setSearch] = useState('')
  const [keyword, setKeyword] = useState('')
  const [source, setSource] = useState<MusicSource>('netease')
  const [playlistScrollElement, setPlaylistScrollElement] = useState<HTMLDivElement | null>(null)
  const results = useMusicSearch(source, open ? keyword : '')
  const actions = useRoomPlaylistActions(onPlaylistUpdated)
  const tracks = results.data?.pages.flatMap((page) => page.items) ?? []
  const busy =
    !connected ||
    actions.add.isPending ||
    actions.remove.isPending ||
    actions.reorder.isPending ||
    actions.shuffle.isPending ||
    actions.clear.isPending ||
    actions.importLiked.isPending

  return (
    <SheetContent className={styles.sheet} aria-describedby={undefined}>
      <SheetHeader>
        <SheetTitle>我的房间歌单</SheetTitle>
      </SheetHeader>
      <div className={styles.columns}>
        <section className={styles.column} aria-label="房间内搜歌">
          <div className={styles.columnHeader}>
            <h3 className={styles.columnTitle}>房间内搜歌</h3>
            <form
              className={styles.searchControls}
              onSubmit={(event) => {
                event.preventDefault()
                const nextKeyword = search.trim()
                setKeyword(nextKeyword)
                if (nextKeyword && nextKeyword === keyword) void results.refetch()
              }}
            >
              <Select
                value={source}
                onValueChange={(value) => value && setSource(value as MusicSource)}
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
              <Button type="submit" size="sm" disabled={!search.trim() || results.isFetching}>
                搜索
              </Button>
            </form>
          </div>
          <div className={styles.scrollArea}>
            {!keyword ? (
              <Empty title="输入关键词搜索" />
            ) : results.isPending ? (
              <Loading />
            ) : results.isError ? (
              <ErrorState error={results.error} retry={() => void results.refetch()} />
            ) : tracks.length ? (
              <TrackList
                tracks={tracks}
                compact
                onAdd={(track) =>
                  actions.add.mutate({
                    source: track.source,
                    source_id: track.source_id,
                    extra: track.extra,
                  })
                }
                disabled={busy}
              />
            ) : (
              <Empty title="没有找到歌曲" />
            )}
            {results.hasNextPage && (
              <Button
                variant="ghost"
                disabled={results.isFetchingNextPage}
                onClick={() => void results.fetchNextPage()}
              >
                加载更多
              </Button>
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
                disabled={busy}
                onClick={() => actions.importLiked.mutate()}
              >
                <Upload />
                导入喜欢
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || snapshot.myPlaylist.length < 2}
                onClick={() => actions.shuffle.mutate()}
              >
                <Shuffle />
                打乱
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !snapshot.myPlaylist.length}
                onClick={() => actions.clear.mutate()}
              >
                <Trash2 />
                清空
              </Button>
            </div>
          </div>
          <div ref={setPlaylistScrollElement} className={styles.scrollArea}>
            {snapshot.myPlaylist.length ? (
              <SortableQueue
                scrollElement={playlistScrollElement}
                tracks={snapshot.myPlaylist.map((item) => item.track)}
                disabled={busy}
                onMove={(track, toIndex) =>
                  actions.reorder.mutate({
                    itemId: snapshot.myPlaylist.find(
                      (item) =>
                        item.track.source === track.source &&
                        item.track.source_id === track.source_id,
                    )!.itemId,
                    toIndex,
                  })
                }
                onRemove={(track) =>
                  actions.remove.mutate(
                    snapshot.myPlaylist.find(
                      (item) =>
                        item.track.source === track.source &&
                        item.track.source_id === track.source_id,
                    )!.itemId,
                  )
                }
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
