'use client'

import { useState, type CSSProperties } from 'react'
import { DragDropProvider, DragOverlay } from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'
import { SortableKeyboardPlugin } from '@dnd-kit/dom/sortable'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { GripVertical, X } from 'lucide-react'
import { trackKey, type Track } from '@/contracts/domain'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import styles from './queue.module.css'

/** 固定行高同时用于虚拟定位与实际样式，保持原有队列密度。 */
const QUEUE_ROW_HEIGHT = 63

/** 个人播放队列与本人房间歌单共用的排序视图，命令仍由各自业务层执行。 */
type SortableQueueProps = {
  tracks: Track[]
  scrollElement: HTMLDivElement | null
  currentIndex?: number
  disabled?: boolean
  onSelect?: (index: number) => void
  onRemove: (track: Track, index: number) => void
  onMove: (track: Track, toIndex: number) => void
}

/** 拖动仅预览完整列表的顺序，落下后才交给业务层提交。 */
type QueueDrag = { key: string; baseline: string; tracks: Track[] }

/** 普通行与拖拽浮层共用封面和歌曲资料。 */
function QueueDetails({ track }: { track: Track }) {
  return (
    <>
      {track.cover_url ? (
        <img className={styles.queueCover} src={track.cover_url} alt="" />
      ) : (
        <span className={styles.queueCover} aria-hidden="true" />
      )}
      <span className={styles.queueDetails}>
        <strong className={styles.queueTitle}>{track.title || '未知标题'}</strong>
        <small className={styles.queueAuthor}>{track.author || '未知作者'}</small>
      </span>
    </>
  )
}

/** 单条歌曲只从手柄启动拖拽，点击歌曲和删除按钮不触发拖动。 */
function SortableQueueRow({
  track,
  index,
  originalIndex,
  count,
  current,
  disabled,
  onSelect,
  onRemove,
}: Omit<SortableQueueProps, 'tracks' | 'scrollElement' | 'currentIndex' | 'onMove'> & {
  track: Track
  index: number
  originalIndex: number
  count: number
  current: boolean
}) {
  const { ref, handleRef, isDragging } = useSortable({
    id: trackKey(track),
    index,
    plugins: [SortableKeyboardPlugin],
    transition: null,
    disabled: disabled ? true : { draggable: current },
  })
  return (
    <div
      ref={ref}
      role="listitem"
      aria-posinset={index + 1}
      aria-setsize={count}
      data-track-key={trackKey(track)}
      aria-current={current ? 'true' : undefined}
      className={cn(styles.queueItem, current && styles.current, isDragging && styles.dragging)}
    >
      {onSelect ? (
        <button
          className={styles.queueSelect}
          type="button"
          onClick={() => onSelect(originalIndex)}
          aria-label={`播放 ${track.title}`}
        >
          <QueueDetails track={track} />
        </button>
      ) : (
        <div className={styles.queueContent}>
          <QueueDetails track={track} />
        </div>
      )}
      <Button
        ref={handleRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        className={styles.dragHandle}
        aria-label={`拖拽排序 ${track.title}`}
        title={current ? '当前歌曲不能拖动' : '拖拽排序'}
        disabled={disabled || current}
      >
        <GripVertical />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`移除 ${track.title}`}
        title={onSelect && current ? '正在播放的歌曲不能移除' : '移除'}
        disabled={disabled || isDragging || (!!onSelect && current)}
        onClick={() => onRemove(track, originalIndex)}
      >
        <X />
      </Button>
    </div>
  )
}

/** 长队列复用抽屉滚动容器；受控排序避免拖拽库移动 DOM 干扰虚拟定位。 */
export function SortableQueue({
  tracks,
  scrollElement,
  currentIndex,
  disabled,
  onMove,
  ...actions
}: SortableQueueProps) {
  const [drag, setDrag] = useState<QueueDrag | null>(null)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const signature = JSON.stringify(tracks.map(trackKey))
  const activeDrag = drag?.baseline === signature ? drag : null
  const displayed = activeDrag?.tracks ?? tracks
  const currentTrack = tracks[currentIndex ?? -1]
  const currentKey = currentTrack && trackKey(currentTrack)
  const originalIndexes = new Map(tracks.map((track, index) => [trackKey(track), index]))
  const virtualized = tracks.length > 50
  const virtual = useVirtualizer({
    count: displayed.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => QUEUE_ROW_HEIGHT,
    getItemKey: (index) => trackKey(displayed[index]),
    overscan: 5,
    enabled: virtualized,
    rangeExtractor: (range) => {
      const indexes = new Set(defaultRangeExtractor(range))
      // 保留拖动源和焦点，滚动时不卸载正在操作的行。
      for (const key of [activeDrag?.key, focusedKey]) {
        const index = displayed.findIndex((track) => trackKey(track) === key)
        if (index >= 0) indexes.add(index)
      }
      return [...indexes].sort((a, b) => a - b)
    },
  })
  /** 行位置来自完整预览列表，业务回调始终使用原队列索引。 */
  const row = (index: number) => {
    const track = displayed[index]
    const key = trackKey(track)
    return (
      <SortableQueueRow
        key={key}
        track={track}
        index={index}
        originalIndex={originalIndexes.get(key)!}
        count={tracks.length}
        current={key === currentKey}
        disabled={disabled}
        {...actions}
      />
    )
  }
  return (
    <DragDropProvider
      onDragStart={({ operation: { source } }) => {
        if (source && !disabled) setDrag({ key: String(source.id), baseline: signature, tracks })
      }}
      onDragOver={({ operation: { target } }) => {
        if (!target || disabled) return
        setDrag((previous) => {
          if (!previous || previous.baseline !== signature) return previous
          const from = previous.tracks.findIndex((track) => trackKey(track) === previous.key)
          const to = previous.tracks.findIndex((track) => trackKey(track) === target.id)
          if (from < 0 || to < 0 || from === to) return previous
          const reordered = [...previous.tracks]
          reordered.splice(to, 0, reordered.splice(from, 1)[0])
          return { ...previous, tracks: reordered }
        })
      }}
      onDragEnd={(event) => {
        if (!event.canceled && event.operation.target && !disabled && activeDrag) {
          const index = activeDrag.tracks.findIndex((track) => trackKey(track) === activeDrag.key)
          if (index >= 0 && originalIndexes.get(activeDrag.key) !== index) {
            onMove(activeDrag.tracks[index], index)
          }
        }
        setDrag(null)
      }}
    >
      <div
        role="list"
        aria-label={actions.onSelect ? '个人播放列表' : '房间歌单'}
        style={{ '--queue-row-height': `${QUEUE_ROW_HEIGHT}px` } as CSSProperties}
        onFocusCapture={(event) =>
          setFocusedKey(
            event.target.closest<HTMLElement>('[data-track-key]')?.dataset.trackKey ?? null,
          )
        }
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null)
        }}
      >
        {virtualized ? (
          <div className={styles.virtualSpace} style={{ height: virtual.getTotalSize() }}>
            {virtual.getVirtualItems().map((item) => (
              <div
                key={item.key}
                className={styles.virtualRow}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row(item.index)}
              </div>
            ))}
          </div>
        ) : (
          displayed.map((_, index) => row(index))
        )}
        <DragOverlay
          className={styles.overlay}
          dropAnimation={null}
          style={{ '--queue-row-height': `${QUEUE_ROW_HEIGHT}px` } as CSSProperties}
        >
          {(source) => {
            const track = tracks.find((track) => trackKey(track) === source.id)
            return track ? (
              <div className={styles.queueItem}>
                <QueueDetails track={track} />
                <GripVertical size={16} />
              </div>
            ) : null
          }}
        </DragOverlay>
      </div>
    </DragDropProvider>
  )
}
