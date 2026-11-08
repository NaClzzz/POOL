'use client'
import sharedStyles from '@/components/presentation.module.css'
import styles from '@/features/music/track-list.module.css'
import { cn } from '@/lib/utils'
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useVirtualizer, useWindowVirtualizer } from '@tanstack/react-virtual'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Heart, Play, Plus, AudioLines } from 'lucide-react'
import { likesApi } from '@/lib/api-client'
import { trackKey, type Track } from '@/contracts/domain'
import { useSession } from '@/stores/session'
import { usePlayer } from '@/stores/player'
import { formatTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** 歌曲行高同时供虚拟列表估算和列表局部 CSS 变量使用。 */
const ROW_HEIGHT = { standard: 60, compact: 56 } as const

/** 将统一歌曲列表展示为紧凑行；长列表用固定行高虚拟化。 */
export function TrackList({
  tracks,
  onAdd,
  compact = false,
  disabled = false,
}: {
  tracks: Track[]
  onAdd?: (track: Track) => void
  compact?: boolean
  disabled?: boolean
}) {
  const parent = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const userId = useSession((s) => s.user!.id)
  const current = usePlayer((s) => s.queue[s.index])
  const playing = usePlayer((s) => s.playing)
  const play = usePlayer((s) => s.play)
  const client = useQueryClient()
  const likes = useQuery({
    queryKey: ['likes', userId],
    queryFn: ({ signal }) => likesApi.list(signal),
    enabled: !onAdd,
  })
  const likedKeys = new Set(likes.data?.map(trackKey) ?? [])
  const mutation = useMutation({
    mutationFn: (track: Track) =>
      likedKeys.has(trackKey(track)) ? likesApi.remove(track) : likesApi.add(track),
    onSuccess: () => client.invalidateQueries({ queryKey: ['likes', userId] }),
  })
  const compactVirtual = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parent.current,
    estimateSize: () => ROW_HEIGHT[compact ? 'compact' : 'standard'],
    getItemKey: (i) => trackKey(tracks[i]),
    overscan: 5,
    enabled: compact && tracks.length > 50,
  })
  const pageVirtual = useWindowVirtualizer({
    count: tracks.length,
    estimateSize: () => ROW_HEIGHT.standard,
    getItemKey: (i) => trackKey(tracks[i]),
    overscan: 5,
    scrollMargin,
    enabled: !compact && tracks.length > 50,
  })
  const virtual = compact ? compactVirtual : pageVirtual
  const hasError = !!mutation.error
  useLayoutEffect(() => {
    if (compact || tracks.length <= 50) return
    /** 列表起点随页头、错误反馈和视口变化重新测量，行定位扣除页面偏移。 */
    const updateMargin = () =>
      setScrollMargin(parent.current!.getBoundingClientRect().top + window.scrollY)
    updateMargin()
    const observer = new ResizeObserver(updateMargin)
    observer.observe(parent.current!.closest('main') ?? parent.current!)
    window.addEventListener('resize', updateMargin)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateMargin)
    }
  }, [compact, tracks.length, hasError])
  /** 渲染单条歌曲；操作按钮不触发行级播放。 */
  const row = (track: Track, index: number) => {
    const active = current && trackKey(current) === trackKey(track)
    return (
      <div
        className={cn(styles.trackRow, compact && styles.compact, active && styles.isCurrent)}
        key={trackKey(track)}
      >
        <button
          className={cn(styles.trackNumber, sharedStyles.action)}
          aria-label={`${onAdd ? '添加' : '播放'} ${track.title}`}
          disabled={disabled}
          onClick={() => (onAdd ? onAdd(track) : play(track, tracks))}
        >
          {active && playing ? (
            <AudioLines className={styles.playingIcon} size={16} />
          ) : (
            <>
              <span className={styles.numberText}>{String(index + 1).padStart(2, '0')}</span>
              <Play className={styles.rowPlay} size={15} />
            </>
          )}
        </button>
        <button
          className={cn(styles.trackMain, sharedStyles.action)}
          disabled={disabled}
          onClick={() => (onAdd ? onAdd(track) : play(track, tracks))}
        >
          <img className={styles.trackCover} src={track.cover_url || '/covers/water.svg'} alt="" />
          <span className="min-w-0">
            <strong className={styles.trackTitle}>{track.title || '未知标题'}</strong>
            <small className={styles.trackAuthor}>
              {track.author || '未知作者'}
              {compact && ` · ${track.source === 'netease' ? '网易云' : 'Bilibili'}`}
            </small>
          </span>
        </button>
        {!compact && (
          <span className={cn(styles.trackAlbum, 'truncate')}>{track.album || '—'}</span>
        )}
        <span className={styles.trackDuration}>{formatTime(track.duration_ms)}</span>
        {onAdd ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label={`添加 ${track.title}`}
            disabled={disabled}
            onClick={() => onAdd(track)}
          >
            <Plus className={styles.actionIcon} />
          </Button>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            aria-label={
              likedKeys.has(trackKey(track)) ? `取消喜欢 ${track.title}` : `喜欢 ${track.title}`
            }
            onClick={() => mutation.mutate(track)}
            disabled={
              mutation.isPending || (likes.data?.length === 500 && !likedKeys.has(trackKey(track)))
            }
            title={
              likes.data?.length === 500 && !likedKeys.has(trackKey(track))
                ? '喜欢列表已满，最多 500 首'
                : undefined
            }
          >
            <Heart
              className={cn(
                styles.actionIcon,
                likedKeys.has(trackKey(track)) && 'fill-primary text-primary',
              )}
            />
          </Button>
        )}
      </div>
    )
  }
  return (
    <div
      className={styles.trackList}
      style={
        {
          '--track-row-height': `${ROW_HEIGHT[compact ? 'compact' : 'standard']}px`,
        } as CSSProperties
      }
    >
      {mutation.error && (
        <p className={cn(sharedStyles.inlineError, 'px-4')}>{mutation.error.message}</p>
      )}
      <div className={cn(styles.trackHeading, compact && styles.compact)}>
        <span>#</span>
        <span>歌曲 / 艺术家</span>
        {!compact && <span>专辑</span>}
        <span>时长</span>
        <span />
      </div>
      {tracks.length > 50 ? (
        <div ref={parent} className={compact ? styles.compactScroll : undefined}>
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((v) => (
              <div
                key={v.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${v.start - (compact ? 0 : scrollMargin)}px)`,
                }}
              >
                {row(tracks[v.index], v.index)}
              </div>
            ))}
          </div>
        </div>
      ) : (
        tracks.map(row)
      )}
    </div>
  )
}
