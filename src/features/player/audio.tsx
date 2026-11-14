'use client'
import { useEffect, useRef } from 'react'
import { usePlayer } from '@/stores/player'
import { trackKey } from '@/contracts/domain'
import { musicApi } from '@/lib/api-client'
import { HttpError } from '@/lib/http'

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
