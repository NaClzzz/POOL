'use client'

import { DragDropProvider } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { GripVertical, X } from 'lucide-react'
import { trackKey, type Track } from '@/contracts/domain'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import styles from './queue.module.css'

/** 个人播放队列与本人房间歌单共用的排序视图，命令仍由各自业务层执行。 */
type SortableQueueProps = {
  tracks: Track[]
  currentIndex?: number
  disabled?: boolean
  onSelect?: (index: number) => void
  onRemove: (track: Track, index: number) => void
  onMove: (track: Track, toIndex: number) => void
}

/** 单条歌曲只从手柄启动拖拽，点击歌曲和删除按钮不触发拖动。 */
function SortableQueueRow({
  track,
  index,
  current,
  disabled,
  onSelect,
  onRemove,
}: Omit<SortableQueueProps, 'tracks' | 'currentIndex' | 'onMove'> & {
  track: Track
  index: number
  current: boolean
}) {
  const { ref, handleRef, isDragging } = useSortable({
    id: trackKey(track),
    index,
    disabled: disabled ? true : { draggable: current },
  })
  const details = (
    <>
      <img className={styles.queueCover} src={track.cover_url || '/covers/water.svg'} alt="" />
      <span className={styles.queueDetails}>
        <strong className={styles.queueTitle}>{track.title || '未知标题'}</strong>
        <small className={styles.queueAuthor}>{track.author || '未知作者'}</small>
      </span>
    </>
  )
  return (
    <div
      ref={ref}
      role="listitem"
      data-track-key={trackKey(track)}
      aria-current={current ? 'true' : undefined}
      className={cn(styles.queueItem, current && styles.current, isDragging && styles.dragging)}
    >
      {onSelect ? (
        <button
          className={styles.queueSelect}
          type="button"
          onClick={() => onSelect(index)}
          aria-label={`播放 ${track.title}`}
        >
          {details}
        </button>
      ) : (
        <div className={styles.queueContent}>{details}</div>
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
        onClick={() => onRemove(track, index)}
      >
        <X />
      </Button>
    </div>
  )
}

/** 默认由库处理鼠标、键盘排序和取消，落下后按歌曲身份提交一次移动命令。 */
export function SortableQueue({
  tracks,
  currentIndex,
  disabled,
  onMove,
  ...actions
}: SortableQueueProps) {
  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled || disabled) return
        const { source } = event.operation
        if (isSortable(source) && source.initialIndex !== source.index) {
          const track = tracks.find((track) => trackKey(track) === source.id)
          if (track) onMove(track, source.index)
        }
      }}
    >
      <div role="list" aria-label={actions.onSelect ? '个人播放列表' : '房间歌单'}>
        {tracks.map((track, index) => (
          <SortableQueueRow
            key={trackKey(track)}
            track={track}
            index={index}
            current={index === currentIndex}
            disabled={disabled}
            {...actions}
          />
        ))}
      </div>
    </DragDropProvider>
  )
}
