'use client'
import { useEffect, useState } from 'react'
import { ListMusic } from 'lucide-react'
import { SheetTrigger } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { useLyrics } from '@/features/music/api'
import { roomPosition } from './use-room-audio'
import type { Playback } from '@/contracts/room'
import styles from './room-page.module.css'
import { cn } from '@/lib/utils'

/** 读取 LRC 并将时间戳转换成毫秒。 */
export function parseRoomLyrics(lrc: string | null | undefined) {
  return (lrc ?? '')
    .split('\n')
    .flatMap((line) => {
      const text = line.replace(/\[[^\]]*\]/g, '').trim()
      return [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)].map((match) => ({
        time: (Number(match[1]) * 60 + Number(match[2])) * 1000,
        text,
      }))
    })
    .filter((line) => line.text)
    .sort((a, b) => a.time - b.time)
}
/** 曲目、真实歌词和当前行，音频播放控制不放在展示组件中。 */
export function RoomNowPlaying({
  playback,
  clockOffset,
}: {
  playback: Playback
  clockOffset: number
}) {
  const track = playback.track,
    [now, setNow] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])
  const lyrics = useLyrics(track)
  const lines = parseRoomLyrics(lyrics.data?.lrc),
    position = roomPosition(playback, now, clockOffset)
  const current = Math.max(
    0,
    lines.findLastIndex((line) => line.time <= position),
  )
  return (
    <div className={styles.nowPlayingPanel}>
      <h3 className={styles.nowPlayingTitle}>正在播放</h3>
      {track ? (
        <>
          {track.cover_url && (
            <img className={styles.roomAlbum} src={track.cover_url} alt="歌曲封面" />
          )}
          <h2 className={styles.trackTitle}>{track.title ?? '未知标题'}</h2>
          <p className={styles.trackAuthor}>{track.author}</p>
          <div className={styles.roomLyrics}>
            {lines.length ? (
              lines.slice(Math.max(0, current - 1), current + 2).map((line, i) => (
                <p
                  key={`${line.time}:${i}`}
                  className={line === lines[current] ? styles.lyricCurrent : undefined}
                >
                  {line.text}
                </p>
              ))
            ) : (
              <p>{lyrics.isPending ? '歌词加载中' : lyrics.error ? '歌词加载失败' : '暂无歌词'}</p>
            )}
          </div>
        </>
      ) : (
        <div className={styles.waitingStage}>
          <h2 className={cn(styles.trackTitle, styles.waitingTitle)}>等待上台</h2>
          <SheetTrigger render={<Button variant="outline" />}>
            <ListMusic />
            我的房间歌单
          </SheetTrigger>
        </div>
      )}
    </div>
  )
}
