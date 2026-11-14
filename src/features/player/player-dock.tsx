'use client'
import styles from '@/features/player/player-dock.module.css'
import sharedStyles from '@/components/presentation.module.css'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import {
  Heart,
  LoaderCircle,
  ListMusic,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  Music2,
  Shuffle,
  ListOrdered,
} from 'lucide-react'
import { usePlayer } from '@/stores/player'
import { useLikes, useAddLike, useRemoveLike } from '@/lib/api-client'
import { trackKey } from '@/contracts/domain'
import { formatTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Slider } from '@/components/ui/slider'
import { SortableQueue } from '@/features/music/sortable-queue'

/** 全局个人播放器；房间加入后隐藏但保留暂停的个人队列。 */
export function PersonalPlayerDock() {
  const state = usePlayer()
  const [queueOpen, setQueueOpen] = useState(false)
  const [queueScrollElement, setQueueScrollElement] = useState<HTMLDivElement | null>(null)
  const likes = useLikes()
  const addLike = useAddLike()
  const removeLike = useRemoveLike()
  const track = state.queue[state.index]
  const liked = !!track && likes.data?.some((t) => trackKey(t) === trackKey(track))
  if (state.roomActive) return null
  return (
    <>
      <footer className={styles.playerDock}>
        <div className={styles.playerDockInner}>
          <div className={styles.dockTrack}>
            {track ? (
              <img src={track.cover_url!} alt="" className={styles.dockCover} />
            ) : (
              <div className={cn(styles.dockCover, styles.emptyCover)}>
                <Music2 />
              </div>
            )}
            <div className="min-w-0">
              <p className={cn(styles.trackTitle, 'truncate font-medium')}>
                {track?.title ?? '未选择歌曲'}
              </p>
              <p className={cn(styles.trackAuthor, 'mt-1 truncate text-xs text-muted-foreground')}>
                {state.error || (state.loading ? '加载中…' : track?.author) || '选择歌曲后播放'}
              </p>
            </div>
            {track && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={liked ? '取消喜欢' : '加入喜欢'}
                onClick={() => {
                  if (liked) removeLike.mutate(track)
                  else addLike.mutate(track)
                }}
                disabled={
                  addLike.isPending ||
                  removeLike.isPending ||
                  (likes.data?.length === 500 && !liked)
                }
                title={
                  likes.data?.length === 500 && !liked ? '喜欢列表已满，最多 500 首' : undefined
                }
              >
                <Heart className={liked ? 'fill-primary text-primary' : ''} />
              </Button>
            )}
          </div>
          <div className={styles.dockCenter}>
            <div className={styles.playButtons}>
              <Button
                variant="ghost"
                size="icon"
                className={cn(styles.playMode)}
                aria-label={
                  state.playbackMode === 'sequential'
                    ? '顺序播放，切换为随机播放'
                    : '随机播放，切换为顺序播放'
                }
                title={state.playbackMode === 'sequential' ? '顺序播放' : '随机播放'}
                disabled={!track}
                onClick={() =>
                  state.setPlaybackMode(
                    state.playbackMode === 'sequential' ? 'shuffle' : 'sequential',
                  )
                }
              >
                {state.playbackMode === 'shuffle' ? (
                  <Shuffle className={styles.playIcon} />
                ) : (
                  <ListOrdered className={styles.playIcon} />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={styles.secondaryPlayButton}
                aria-label="上一首"
                disabled={!track}
                onClick={state.previous}
              >
                <SkipBack className={styles.playIcon} />
              </Button>
              <Button
                className={styles.playMain}
                size="icon"
                aria-label={state.playing ? '暂停' : '播放'}
                disabled={!track}
                onClick={state.toggle}
              >
                {state.loading ? (
                  <LoaderCircle className={cn(styles.playIcon, 'animate-spin')} />
                ) : state.playing ? (
                  <Pause className={cn(styles.playIcon, 'fill-current')} />
                ) : (
                  <Play className={cn(styles.playIcon, 'fill-current')} />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={styles.secondaryPlayButton}
                aria-label="下一首"
                disabled={!track}
                onClick={state.next}
              >
                <SkipForward className={styles.playIcon} />
              </Button>
            </div>
            <div className={styles.progressRow}>
              <span>{formatTime(state.position * 1000)}</span>
              <Slider
                className={styles.progressSlider}
                aria-label="个人播放进度"
                min={0}
                max={state.duration || 1}
                step={0.1}
                value={[Math.min(state.position, state.duration)]}
                disabled={!track || state.loading}
                onValueChange={(value) => state.seek((value as number[])[0])}
              />
              <span>{formatTime(track ? state.duration * 1000 : null)}</span>
            </div>
          </div>
          <div className={styles.dockTools}>
            <Volume2 className={styles.volumeIcon} size={17} />
            <Slider
              className={styles.volumeSlider}
              aria-label="音量"
              min={0}
              max={1}
              step={0.01}
              value={[state.volume]}
              onValueChange={(value) => state.setVolume((value as number[])[0])}
            />
            <span className={styles.dockDivider} />
            <Sheet modal="trap-focus" open={queueOpen} onOpenChange={setQueueOpen}>
              <SheetTrigger
                render={<Button variant="ghost" size="icon" aria-label="个人播放队列" />}
              >
                <ListMusic className={styles.queueIcon} />
              </SheetTrigger>
              <SheetContent aria-describedby={undefined}>
                <SheetHeader>
                  <SheetTitle>播放队列 · {state.queue.length}</SheetTitle>
                </SheetHeader>
                <div ref={setQueueScrollElement} className={sharedStyles.sheetBody}>
                  {state.queue.length ? (
                    <SortableQueue
                      scrollElement={queueScrollElement}
                      tracks={state.queue}
                      currentIndex={state.index}
                      onSelect={state.select}
                      onMove={state.move}
                      onRemove={(_, index) => state.remove(index)}
                    />
                  ) : (
                    <p className="py-8 text-center text-muted-foreground">队列为空</p>
                  )}
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </footer>
    </>
  )
}
