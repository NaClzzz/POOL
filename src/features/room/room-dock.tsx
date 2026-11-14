'use client'
import { useEffect, useState } from 'react'
import { Headphones, SkipForward, Volume2, ListMusic } from 'lucide-react'
import { usePlayer } from '@/stores/player'
import { useSession } from '@/stores/session'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { SheetTrigger } from '@/components/ui/sheet'
import { formatTime, cn } from '@/lib/utils'
import type { RoomSnapshot } from '@/contracts/room'
import { roomPosition } from './use-room-audio'
import styles from '@/features/player/player-dock.module.css'

/** 房间播放栏只读进度，不提供暂停或拖动。 */
export function RoomDock({
  snapshot,
  connected,
  clockOffset,
  error,
  needsUnlock,
  unlock,
  onSkip,
}: {
  snapshot: RoomSnapshot
  connected: boolean
  clockOffset: number
  error: string
  needsUnlock: boolean
  unlock: () => void
  onSkip: () => void
}) {
  const userId = useSession((s) => s.user!.id),
    volume = usePlayer((s) => s.volume),
    setVolume = usePlayer((s) => s.setVolume)
  const [now, setNow] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  const p = snapshot.playback,
    elapsed = roomPosition(p, now, clockOffset),
    duration = p.durationMs ?? 0,
    progress = duration ? (elapsed / duration) * 100 : 0
  return (
    <footer className={styles.playerDock}>
      <div className={styles.playerDockInner}>
        <div className={styles.dockTrack}>
          {p.track?.cover_url ? (
            <img className={styles.dockCover} src={p.track.cover_url} alt="" />
          ) : (
            <div className={cn(styles.dockCover, styles.emptyCover)}>
              <Headphones />
            </div>
          )}
          <div className="min-w-0">
            <p className={cn(styles.trackTitle, 'truncate font-medium')}>
              {p.track?.title ?? '等待播放'}
            </p>
            <p className={cn(styles.trackAuthor, 'mt-1 text-xs text-muted-foreground')}>
              {p.track?.author}
              <span className="ml-2 text-primary">一起听</span>
            </p>
          </div>
        </div>
        <div className={styles.roomDockCenter}>
          {needsUnlock ? (
            <Button size="sm" onClick={unlock}>
              启用声音
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className={styles.roomPlaybackButton}
              disabled={!connected || !p.track || p.votes.includes(userId)}
              onClick={onSkip}
            >
              <SkipForward />
              {p.activeMemberId === userId
                ? '切歌'
                : `投票切歌 ${p.votes.length}/${p.skipVoteRequired}`}
            </Button>
          )}
          {error && !needsUnlock && (
            <span className="text-xs text-destructive" role="status">
              {error}
            </span>
          )}
          <div className={cn(styles.progressRow, styles.roomProgress)}>
            <span>{formatTime(elapsed)}</span>
            <div
              className={styles.readonlyProgress}
              role="progressbar"
              aria-label="房间播放进度，只读"
              aria-valuenow={Math.round(progress)}
            >
              <span className={styles.progressFill} style={{ width: `${progress}%` }} />
            </div>
            <span>{duration ? formatTime(duration) : '—'}</span>
          </div>
        </div>
        <div className={styles.dockTools}>
          <Volume2 className={styles.volumeIcon} size={17} />
          <Slider
            className={styles.volumeSlider}
            aria-label="房间音量"
            min={0}
            max={1}
            step={0.01}
            value={[volume]}
            onValueChange={(value) => setVolume((value as number[])[0])}
          />
          <span className={styles.dockDivider} />
          <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="我的房间歌单" />}>
            <ListMusic className={styles.queueIcon} />
          </SheetTrigger>
        </div>
      </div>
    </footer>
  )
}
