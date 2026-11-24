'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { musicApi } from '@/features/music/api'
import { usePlayer } from '@/stores/player'
import type { Playback } from '@/contracts/room'

/** 加载媒体及等待起播都支持取消，旧节目事件不会污染新节目。 */
async function waitForAudio(audio: HTMLAudioElement, signal: AbortSignal) {
  if (audio.readyState >= 3) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('音频加载超时')), 30_000)
    /** 所有完成路径移除同一批媒体监听器。 */
    const finish = (error?: Error) => {
      clearTimeout(timer)
      audio.removeEventListener('canplay', ready)
      audio.removeEventListener('error', failed)
      signal.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve()
    }
    const ready = () => finish()
    const failed = () => finish(new Error('音频加载失败'))
    const cancel = () => finish(new DOMException('已取消', 'AbortError'))
    audio.addEventListener('canplay', ready, { once: true })
    audio.addEventListener('error', failed, { once: true })
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}
/** 可取消的起播等待，不使用不可清理的延迟任务。 */
async function waitUntil(delay: number, signal: AbortSignal) {
  if (delay <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, delay)
    const cancel = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      reject(new DOMException('已取消', 'AbortError'))
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}
/** 时间轴进度供播放器和实际音频共用，客户端时钟通过加入快照校准。 */
export function roomPosition(playback: Playback, now: number, offset: number) {
  return playback.startedAt === null
    ? 0
    : Math.max(
        0,
        Math.min(
          playback.durationMs ?? Infinity,
          now + offset - playback.startedAt + playback.startOffsetMs,
        ),
      )
}
/** 真实房间音频；仅当前播放者的有效版本可报告媒体失败。 */
export function useRoomAudio(
  playback: Playback | undefined,
  connected: boolean,
  clockOffset: number,
  onMediaError: (version: number, itemId: string) => void,
) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [error, setError] = useState(''),
    [needsUnlock, setNeedsUnlock] = useState(false)
  const volume = usePlayer((s) => s.volume)
  const latest = useRef({ playback, clockOffset, onMediaError })
  useEffect(() => {
    latest.current = { playback, clockOffset, onMediaError }
  }, [playback, clockOffset, onMediaError])
  /** 对齐最新时间轴后播放，自动播放限制不报告为曲目失败。 */
  const alignAndPlay = useCallback(async () => {
    const audio = audioRef.current,
      current = latest.current
    if (!audio || !current.playback?.track || !audio.src) return
    if (
      current.playback.startedAt !== null &&
      Date.now() + current.clockOffset < current.playback.startedAt
    )
      return
    const target = roomPosition(current.playback, Date.now(), current.clockOffset) / 1000
    audio.currentTime = Number.isFinite(audio.duration)
      ? Math.min(target, Math.max(0, audio.duration - 0.05))
      : target
    try {
      await audio.play()
      setError('')
      setNeedsUnlock(false)
    } catch (failure) {
      if ((failure as Error).name === 'NotAllowedError') {
        setNeedsUnlock(true)
        setError('请点击启用声音')
      } else if ((failure as Error).name !== 'AbortError') throw failure
    }
  }, [])
  const version = playback?.version,
    status = playback?.status
  useEffect(() => {
    const audio = audioRef.current,
      abort = new AbortController()
    if (!audio) return
    const currentPlayback = latest.current.playback
    const track = currentPlayback?.track
    let failed = false
    /** 每个节目本机最多报告一次，旧请求取消不触发跳歌。 */
    const report = (failure: unknown) => {
      if (abort.signal.aborted || failed) return
      failed = true
      setError((failure as Error).message || '当前歌曲无法播放')
      setNeedsUnlock(false)
      if (currentPlayback?.currentItemId)
        latest.current.onMediaError(currentPlayback.version, currentPlayback.currentItemId)
    }
    const mediaFailure = () => report(new Error('当前音频加载失败'))
    if (connected && status === 'playing' && track) {
      audio.addEventListener('error', mediaFailure)
      void (async () => {
        const resource = await musicApi.playback(track, abort.signal)
        if (abort.signal.aborted) return
        setError('')
        setNeedsUnlock(false)
        audio.src = resource.url
        audio.load()
        await waitForAudio(audio, abort.signal)
        await waitUntil(
          Math.max(0, (currentPlayback?.startedAt ?? 0) - Date.now() - latest.current.clockOffset),
          abort.signal,
        )
        if (!abort.signal.aborted) await alignAndPlay()
      })().catch(report)
    } else {
      audio.pause()
    }
    /** 后台标签页恢复时重新定位，禁止使用旧 currentTime 直接续播。 */
    const visible = () => {
      if (!document.hidden && !abort.signal.aborted && audio.readyState >= 3)
        void alignAndPlay().catch(report)
    }
    if (connected && track) document.addEventListener('visibilitychange', visible)
    return () => {
      abort.abort()
      document.removeEventListener('visibilitychange', visible)
      audio.removeEventListener('error', mediaFailure)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }, [version, status, connected, alignAndPlay])
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume, connected, version])
  return {
    audioRef,
    error,
    needsUnlock,
    unlock: () => void alignAndPlay().catch((failure) => setError((failure as Error).message)),
  }
}
