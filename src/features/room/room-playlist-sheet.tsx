'use client'

import { useState } from 'react'
import { Search, Shuffle, Trash2, Upload } from 'lucide-react'
import type { RoomSnapshot } from '@/contracts/room'
import type { MusicSource } from '@/contracts/domain'
import type { RoomCommand } from './types'
import { useMusicSearch } from '@/lib/api-client'
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
  connected: boolean
  command: RoomCommand
}

/** 左列搜索加歌、右列管理歌单；两个内容区域独立滚动。 */
export function RoomPlaylistSheet({
  snapshot,
  open,
  error,
  connected,
  command,
}: RoomPlaylistSheetProps) {
  const [search, setSearch] = useState('')
  const [keyword, setKeyword] = useState('')
  const [source, setSource] = useState<MusicSource>('netease')
  const [playlistScrollElement, setPlaylistScrollElement] = useState<HTMLDivElement | null>(null)
  const results = useMusicSearch(source, open ? keyword : '')
  const tracks = results.data?.pages.flatMap((page) => page.items) ?? []
  const disconnected = !connected
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
                  void command('room:playlist:add', {
                    source: track.source,
                    source_id: track.source_id,
                    extra: track.extra,
                  })
                }
                disabled={disconnected}
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
                disabled={disconnected}
                onClick={() => void command('room:playlist:import-liked', {})}
              >
                <Upload />
                导入喜欢
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={disconnected || snapshot.myPlaylist.length < 2}
                onClick={() => void command('room:playlist:shuffle', {})}
              >
                <Shuffle />
                打乱
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={disconnected || !snapshot.myPlaylist.length}
                onClick={() => void command('room:playlist:clear', {})}
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
                disabled={disconnected}
                onMove={(track, toIndex) =>
                  void command('room:playlist:reorder', {
                    itemId: snapshot.myPlaylist.find(
                      (item) =>
                        item.track.source === track.source &&
                        item.track.source_id === track.source_id,
                    )!.itemId,
                    toIndex,
                  })
                }
                onRemove={(track) =>
                  void command('room:playlist:remove', {
                    itemId: snapshot.myPlaylist.find(
                      (item) =>
                        item.track.source === track.source &&
                        item.track.source_id === track.source_id,
                    )!.itemId,
                  })
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
