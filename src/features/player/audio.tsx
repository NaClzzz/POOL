'use client'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { usePlayer } from '@/stores/player'
import { trackKey, type Playback, type Track } from '@/contracts/domain'
import { musicApi } from '@/lib/api-client'
import { HttpError } from '@/lib/http'

/** 将统一条目映射到本地原创演示资源，不使用平台真实地址。 */
export function audioUrl(track: Track) {
  return `/audio/${track.extra?.demoAudio === 'dusk' ? 'dusk' : 'tide'}.wav`
}

/** 常驻个人音频只播放统一服务解析的真实资源，取消旧解析防止切歌竞争。 */
export function PersonalAudio() {
  const ref = useRef<HTMLAudioElement>(null)
  const ready = useRef(false)
  const expiresAt = useRef<number | null>(null)
  const track = usePlayer((state) => state.queue[state.index])
  const playing = usePlayer((state) => state.playing)
  const volume = usePlayer((state) => state.volume)
  const seekTo = usePlayer((state) => state.seekTo)
  const roomActive = usePlayer((state) => state.roomActive)
  const loadVersion = usePlayer((state) => state.loadVersion)

  /** 浏览器自动播放限制仅暂停本机，不能误判曲目不可播放而跳歌。 */
  const playAudio = (audio: HTMLAudioElement) => {
    const source = audio.src
    void audio.play().catch((error: DOMException) => {
      if (!ready.current || audio.src !== source) return
      if (error.name === 'AbortError') return
      if (error.name === 'NotAllowedError')
        usePlayer.setState({ playing: false, error: '点击播放以启用声音' })
      else {
        ready.current = false
        usePlayer.getState().failTrack('音频播放失败，请重试')
      }
    })
  }

  useEffect(() => {
    const audio = ref.current!
    const controller = new AbortController()
    let active = true
    ready.current = false
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    if (!track || roomActive) {
      usePlayer.setState({ loading: false })
      return
    }
    usePlayer.setState({ loading: true })
    void musicApi
      .playback(track, controller.signal)
      .then((resource) => {
        if (!active) return
        audio.src = resource.url
        audio.dataset.trackKey = trackKey(track)
        expiresAt.current = resource.expires_at ? Date.parse(resource.expires_at) : null
        ready.current = true
        audio.load()
        usePlayer.setState({
          loading: false,
          duration: (resource.duration_ms ?? track.duration_ms ?? 0) / 1000,
        })
        if (usePlayer.getState().playing) playAudio(audio)
      })
      .catch((error: Error) => {
        if (!active || controller.signal.aborted) return
        if (
          error instanceof HttpError &&
          ['TRACK_UNPLAYABLE', 'TRACK_NOT_FOUND', 'CAPABILITY_NOT_SUPPORTED'].includes(error.code)
        )
          usePlayer.getState().failTrack(error.message)
        else
          usePlayer.setState({
            loading: false,
            playing: false,
            error: error.message || '播放资源解析失败，请重试',
          })
      })
    return () => {
      active = false
      controller.abort()
      ready.current = false
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }, [track, roomActive, loadVersion])

  useEffect(() => {
    const audio = ref.current!
    if (!playing || roomActive) {
      audio.pause()
      return
    }
    if (!ready.current) return
    if (expiresAt.current !== null && expiresAt.current <= Date.now())
      usePlayer.getState().reloadPlayback()
    else playAudio(audio)
  }, [playing, roomActive])
  useEffect(() => {
    ref.current!.volume = volume
  }, [volume])
  useEffect(() => {
    const audio = ref.current!
    if (seekTo !== null && ready.current && audio.readyState >= 1) {
      audio.currentTime = seekTo
      usePlayer.setState({ seekTo: null })
      if (usePlayer.getState().playing) playAudio(audio)
    }
  }, [seekTo])
  return (
    <audio
      ref={ref}
      preload="metadata"
      onLoadedMetadata={(event) => {
        const audio = event.currentTarget
        if (!track || audio.dataset.trackKey !== trackKey(track) || !ready.current) return
        usePlayer.setState({ duration: audio.duration })
        const target = usePlayer.getState().seekTo
        if (target !== null) {
          audio.currentTime = Math.min(target, audio.duration)
          usePlayer.setState({ seekTo: null })
        }
      }}
      onPlaying={() => {
        if (ready.current) usePlayer.setState({ failedCount: 0, error: null })
      }}
      onTimeUpdate={(event) =>
        ready.current && usePlayer.setState({ position: event.currentTarget.currentTime })
      }
      onEnded={() => usePlayer.getState().next()}
      onError={() => {
        if (ready.current && !roomActive) {
          ready.current = false
          usePlayer.getState().failTrack('当前音频加载失败')
        }
      }}
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
