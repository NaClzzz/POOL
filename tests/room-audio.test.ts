// @vitest-environment jsdom
import { act, createElement, useEffect, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Playback } from '@/contracts/room'

const { playbackRequest } = vi.hoisted(() => ({ playbackRequest: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ musicApi: { playback: playbackRequest } }))
vi.mock('@/stores/player', () => ({
  usePlayer: (selector: (state: { volume: number }) => unknown) => selector({ volume: 0.5 }),
}))
import { useRoomAudio, roomPosition } from '@/features/room/use-room-audio'

let root: Root, host: HTMLDivElement, audio: HTMLAudioElement
let state: ReturnType<typeof useRoomAudio>
const report = vi.fn()
const current: Playback = {
  roomId: 'room',
  roomCode: 'code',
  version: 1,
  status: 'playing',
  activeMemberId: 'a',
  currentItemId: 'item',
  track: {
    source: 'netease',
    source_id: '123',
    title: '歌曲',
    author: null,
    album: null,
    cover_url: null,
    duration_ms: 120000,
    extra: null,
  },
  startedAt: 10000,
  startOffsetMs: 0,
  durationMs: 120000,
  votes: [],
  skipVoteRequired: 1,
}
/** 原生媒体行为通过可控事件驱动，React 生命周期及 hook 使用真实实现。 */
function Probe({ playback, connected = true }: { playback: Playback; connected?: boolean }) {
  const audioState = useRoomAudio(playback, connected, 1000, report)
  useEffect(() => {
    state = audioState
  })
  return createElement('audio', { ref: audioState.audioRef as RefObject<HTMLAudioElement> })
}
/** 等待媒体 promise 的微任务，不依赖真实网络。 */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(20000)
  report.mockReset()
  playbackRequest.mockReset()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
    configurable: true,
    get: () => 120,
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true,
    get: () => 3,
  })
  playbackRequest.mockResolvedValue({ url: 'https://audio.example/123.mp3', delivery: 'direct' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('真实房间音频控制器', () => {
  it('使用服务器锚点、偏移及客户端校时计算只读进度', () => {
    expect(roomPosition(current, 20000, 1000)).toBe(11000)
    expect(roomPosition(current, 0, 0)).toBe(0)
    expect(roomPosition(current, 999999, 0)).toBe(120000)
  })
  it('资源加载后重新计算进度；切歌取消旧请求，卸载清空媒体', async () => {
    let resolve!: (value: unknown) => void
    let signal!: AbortSignal
    playbackRequest.mockImplementationOnce((_track, incoming: AbortSignal) => {
      signal = incoming
      return new Promise((done) => {
        resolve = done
      })
    })
    await act(async () => root.render(createElement(Probe, { playback: current })))
    audio = host.querySelector('audio')!
    vi.setSystemTime(25000)
    resolve({ url: 'https://audio.example/123.mp3' })
    await flush()
    expect(audio.currentTime).toBe(16)
    await act(async () =>
      root.render(createElement(Probe, { playback: { ...current, version: 2, startedAt: 24000 } })),
    )
    expect(signal.aborted).toBe(true)
    expect(audio.currentTime).toBe(2)
    await act(async () => root.unmount())
    expect(audio.getAttribute('src')).toBe(null)
    root = createRoot(host)
  })
  it('预加载期间恢复可见不提前播放，起播后使用已保存音量', async () => {
    await act(async () =>
      root.render(createElement(Probe, { playback: { ...current, startedAt: 25000 } })),
    )
    audio = host.querySelector('audio')!
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    expect(audio.volume).toBe(0.5)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
  })
  it('自动播放限制只提示启用声音，用户解锁重新定位，不误报跳歌', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new DOMException('blocked', 'NotAllowedError'),
    )
    await act(async () => root.render(createElement(Probe, { playback: current })))
    expect(state.needsUnlock).toBe(true)
    expect(report).not.toHaveBeenCalled()
    vi.setSystemTime(30000)
    await act(async () => state.unlock())
    audio = host.querySelector('audio')!
    expect(audio.currentTime).toBe(21)
    expect(state.needsUnlock).toBe(false)
  })
  it('同一版本媒体失败只报告一次，断线取消并停音', async () => {
    await act(async () => root.render(createElement(Probe, { playback: current })))
    audio = host.querySelector('audio')!
    await act(async () => {
      audio.dispatchEvent(new Event('error'))
      audio.dispatchEvent(new Event('error'))
    })
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(1, 'item')
    await act(async () =>
      root.render(createElement(Probe, { playback: current, connected: false })),
    )
    expect(audio.getAttribute('src')).toBe(null)
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
  })
  it('起播等待和媒体加载计时器卸载后全部取消，不再报告失败', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const cancelTimer = vi.spyOn(globalThis, 'clearTimeout')
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      configurable: true,
      get: () => 0,
    })
    await act(async () =>
      root.render(createElement(Probe, { playback: { ...current, startedAt: 24000 } })),
    )
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    const loadingTimer =
      timers.mock.results[timers.mock.calls.findIndex((call) => call[1] === 15_000)].value
    await act(async () => root.unmount())
    expect(cancelTimer).toHaveBeenCalledWith(loadingTimer)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(report).not.toHaveBeenCalled()
    root = createRoot(host)
  })
})
