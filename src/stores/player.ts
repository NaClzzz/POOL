import { create } from 'zustand'
import { trackKey, type Track } from '@/contracts/domain'

/** 个人与房间播放器共用的本地音量存储键。 */
export const PLAYER_VOLUME_KEY = 'pool:player:volume'

/** 个人队列的播放顺序；随机模式先打乱队列，再依次循环。 */
export type PlaybackMode = 'sequential' | 'shuffle'

/** 保留当前歌曲在队首，只打乱剩余曲目，不修改传入队列。 */
function shuffleKeepingCurrent(queue: Track[], current: Track | undefined) {
  const remaining = queue.filter((track) => track !== current)
  for (let i = remaining.length - 1; i > 0; i--) {
    const target = Math.floor(Math.random() * (i + 1))
    ;[remaining[i], remaining[target]] = [remaining[target], remaining[i]]
  }
  return current ? [current, ...remaining] : remaining
}

/** 个人音频的跨页交互状态；浏览器实例始终由控制器持有。 */
type PlayerStore = {
  queue: Track[]
  baseQueue: Track[]
  playbackMode: PlaybackMode
  index: number
  playing: boolean
  volume: number
  position: number
  duration: number
  seekTo: number | null
  roomActive: boolean
  error: string | null
  loading: boolean
  loadVersion: number
  failedCount: number
  failTrack: (message: string) => void
  reloadPlayback: () => void
  play: (track: Track, context?: Track[]) => void
  toggle: () => void
  next: () => void
  previous: () => void
  setVolume: (volume: number) => void
  seek: (seconds: number) => void
  add: (track: Track) => void
  remove: (index: number) => void
  move: (track: Track, toIndex: number) => void
  setPlaybackMode: (mode: PlaybackMode) => void
  select: (index: number) => void
  setRoom: (active: boolean) => void
  reset: () => void
}

/** 管理个人播放队列和控制意图，房间音频不存入此队列。 */
export const usePlayer = create<PlayerStore>((set, get) => ({
  queue: [],
  baseQueue: [],
  playbackMode: 'sequential',
  index: 0,
  playing: false,
  volume: 0.6,
  position: 0,
  duration: 0,
  seekTo: null,
  roomActive: false,
  error: null,
  loading: false,
  loadVersion: 0,
  failedCount: 0,
  play: (track, context) => {
    const baseQueue = context?.length ? [...context] : [track]
    const current = baseQueue.find((t) => trackKey(t) === trackKey(track))!
    const queue =
      get().playbackMode === 'shuffle' ? shuffleKeepingCurrent(baseQueue, current) : baseQueue
    set({
      baseQueue,
      queue,
      duration: (current.duration_ms ?? 0) / 1000,
      failedCount: 0,
      index: queue.indexOf(current),
      playing: true,
      position: 0,
      seekTo: 0,
      error: null,
    })
  },
  /** 从现有队列选择歌曲，复用统一的音频定位入口。 */
  select: (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= get().queue.length) return
    set({
      index,
      playing: true,
      position: 0,
      seekTo: 0,
      error: null,
      failedCount: 0,
      duration: (get().queue[index].duration_ms ?? 0) / 1000,
    })
  },
  toggle: () =>
    set((s) => ({
      playing: !s.playing,
      error: null,
      failedCount: 0,
      ...(s.error && !s.playing ? { loadVersion: s.loadVersion + 1 } : {}),
    })),
  next: () =>
    set((s) => ({
      index: (s.index + 1) % Math.max(1, s.queue.length),
      duration: (s.queue[(s.index + 1) % Math.max(1, s.queue.length)]?.duration_ms ?? 0) / 1000,
      failedCount: 0,
      position: 0,
      seekTo: 0,
      playing: true,
      error: null,
    })),
  previous: () =>
    set((s) => ({
      index: (s.index - 1 + s.queue.length) % Math.max(1, s.queue.length),
      duration:
        (s.queue[(s.index - 1 + s.queue.length) % Math.max(1, s.queue.length)]?.duration_ms ?? 0) /
        1000,
      failedCount: 0,
      position: 0,
      seekTo: 0,
      playing: true,
      error: null,
    })),
  setVolume: (volume) => {
    if (typeof window !== 'undefined') localStorage.setItem(PLAYER_VOLUME_KEY, String(volume))
    set({ volume })
  },
  seek: (seconds) => set({ seekTo: seconds, position: seconds }),
  add: (track) =>
    set((s) =>
      s.queue.some((t) => trackKey(t) === trackKey(track))
        ? s
        : {
            queue: [...s.queue, track],
            baseQueue: [...s.baseQueue, track],
          },
    ),
  remove: (index) => {
    const s = get()
    if (!Number.isInteger(index) || index < 0 || index >= s.queue.length) return
    const queue = s.queue.filter((_, i) => i !== index)
    set({
      queue,
      baseQueue: s.baseQueue.filter((track) => trackKey(track) !== trackKey(s.queue[index])),
      index: Math.max(0, Math.min(s.index - (index < s.index ? 1 : 0), queue.length - 1)),
      playing: queue.length > 0 && s.playing,
    })
  },
  /** 排序追踪当前歌曲身份，避免索引变化导致误切歌。 */
  move: (track, toIndex) => {
    const s = get()
    const fromIndex = s.queue.findIndex((t) => trackKey(t) === trackKey(track))
    if (
      fromIndex < 0 ||
      fromIndex === s.index ||
      !Number.isInteger(toIndex) ||
      toIndex < 0 ||
      toIndex >= s.queue.length ||
      fromIndex === toIndex
    )
      return
    const current = s.queue[s.index]
    const queue = [...s.queue]
    const [moved] = queue.splice(fromIndex, 1)
    queue.splice(toIndex, 0, moved)
    set({
      queue,
      index: queue.indexOf(current),
    })
  },
  /** 切换模式只重排队列；当前歌曲、进度和暂停意图不变。 */
  setPlaybackMode: (playbackMode) => {
    const s = get()
    if (playbackMode === s.playbackMode) return
    const current = s.queue[s.index]
    const queue =
      playbackMode === 'shuffle' ? shuffleKeepingCurrent(s.queue, current) : [...s.baseQueue]
    set({ playbackMode, queue, index: Math.max(0, queue.indexOf(current)) })
  },
  /** 不可播放时跳到下一首；整轮都失败则停止，避免无限循环请求。 */
  failTrack: (message) =>
    set((state) => {
      const failedCount = state.failedCount + 1
      if (failedCount >= state.queue.length)
        return { playing: false, loading: false, error: message, failedCount }
      const index = (state.index + 1) % state.queue.length
      return {
        index,
        failedCount,
        position: 0,
        seekTo: 0,
        loading: false,
        duration: (state.queue[index].duration_ms ?? 0) / 1000,
        error: `已跳过不可播放歌曲：${message}`,
      }
    }),
  /** 暂停过久后的恢复重新解析地址，保留当前播放位置。 */
  reloadPlayback: () =>
    set((state) => ({ loadVersion: state.loadVersion + 1, seekTo: state.position })),
  setRoom: (active) => set({ roomActive: active, playing: false }),
  reset: () =>
    set({
      queue: [],
      baseQueue: [],
      failedCount: 0,
      loading: false,
      loadVersion: 0,
      playbackMode: 'sequential',
      index: 0,
      playing: false,
      position: 0,
      seekTo: null,
      roomActive: false,
      error: null,
    }),
}))
