'use client'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { usePlayer } from '@/stores/player'
import type { Playback, Track } from '@/contracts/domain'

/** 将统一条目映射到本地原创演示资源，不使用平台真实地址。 */
export function audioUrl(track: Track) {
  return `/audio/${track.extra?.demoAudio === 'dusk' ? 'dusk' : 'tide'}.wav`
}

/** 唯一常驻个人音频元素，按曲目、播放意图和定位请求分别更新。 */
export function PersonalAudio() {
  const ref = useRef<HTMLAudioElement>(null)
  const track = usePlayer((s) => s.queue[s.index])
  const playing = usePlayer((s) => s.playing)
  const volume = usePlayer((s) => s.volume)
  const seekTo = usePlayer((s) => s.seekTo)
  const roomActive = usePlayer((s) => s.roomActive)
  useEffect(() => {
    const audio = ref.current!
    if (!track) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      return
    }
    audio.src = audioUrl(track)
    audio.load()
    return () => {
      audio.pause()
    }
  }, [track])
  useEffect(() => {
    const audio = ref.current!
    if (playing && !roomActive && track)
      void audio
        .play()
        .catch(() => usePlayer.setState({ playing: false, error: '点击播放以启用声音' }))
    else audio.pause()
  }, [playing, roomActive, track])
  useEffect(() => {
    ref.current!.volume = volume
  }, [volume])
  useEffect(() => {
    if (seekTo !== null && ref.current!.readyState >= 1) {
      ref.current!.currentTime = seekTo
      usePlayer.setState({ seekTo: null })
      if (usePlayer.getState().playing)
        void ref
          .current!.play()
          .catch(() => usePlayer.setState({ playing: false, error: '点击播放以启用声音' }))
    }
  }, [seekTo])
  return (
    <audio
      ref={ref}
      preload="metadata"
      onLoadedMetadata={(e) => {
        const audio = e.currentTarget
        usePlayer.setState({ duration: audio.duration })
        if (usePlayer.getState().seekTo !== null) {
          audio.currentTime = usePlayer.getState().seekTo!
          usePlayer.setState({ seekTo: null })
        }
      }}
      onTimeUpdate={(e) => usePlayer.setState({ position: e.currentTarget.currentTime })}
      onEnded={() => usePlayer.getState().next()}
      onError={() => usePlayer.setState({ playing: false, error: '演示音频加载失败，请重试' })}
    />
  )
}

/** 房间页音频按版本与锚点定位，卸载或切歌时取消旧加载和等待。 */
export function useRoomAudio(
  playback: Playback | undefined,
  connected: boolean,
  onError: (version: number) => void,
  audioRef: RefObject<HTMLAudioElement | null>,
) {
  const volume = usePlayer((s) => s.volume)
  const [error, setError] = useState('')
  const track = playback?.track
  const url = track ? audioUrl(track) : null
  const version = playback?.version
  const startedAt = playback?.startedAt ?? 0
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!url || !connected) {
      audio.pause()
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout>
    /** 对齐服务端起播锚点后请求播放，自动播放限制只影响本地声音。 */
    const start = () => {
      if (!active) return
      audio.currentTime = Math.max(
        0,
        Math.min((Date.now() - startedAt) / 1000, audio.duration - 0.05),
      )
      void audio.play().then(
        () => {
          if (active) setError('')
        },
        () => {
          if (active) setError('点击启用声音，加入这场一起听')
        },
      )
    }
    audio.pause()
    audio.src = url
    audio.onloadedmetadata = () => {
      timer = setTimeout(start, Math.max(0, startedAt - Date.now()))
    }
    audio.load()
    return () => {
      active = false
      clearTimeout(timer)
      audio.onloadedmetadata = null
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }, [url, version, startedAt, connected, audioRef])
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume, audioRef, connected])
  /** 用户手势解锁房间音频，并重新计算当前目标进度。 */
  const unlock = () => {
    const audio = audioRef.current
    if (!audio || !track) return
    audio.currentTime = Math.max(0, Math.min((Date.now() - startedAt) / 1000, 23.95))
    void audio.play().then(
      () => setError(''),
      () => setError('声音尚未启用，请再试一次'),
    )
  }
  return {
    error,
    unlock,
    mediaError: () => {
      setError('当前歌曲无法播放')
      if (version !== undefined) onError(version)
    },
  }
}
