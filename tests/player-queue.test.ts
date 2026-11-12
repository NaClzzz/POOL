import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayer } from '@/stores/player'
import { catalog } from '@/mocks/fixtures'
import { trackKey } from '@/contracts/domain'

beforeEach(() => usePlayer.getState().reset())
afterEach(() => vi.restoreAllMocks())

describe('个人播放队列与模式切换', () => {
  it('不可播放时继续队列，整轮失败后停止，避免无限解析', () => {
    const tracks = catalog.slice(0, 3)
    usePlayer.getState().play(tracks[0], tracks)
    usePlayer.getState().failTrack('没有可用资源')
    expect(usePlayer.getState()).toMatchObject({ index: 1, playing: true, failedCount: 1 })
    usePlayer.getState().failTrack('仅有试听')
    usePlayer.getState().failTrack('资源不存在')
    expect(usePlayer.getState()).toMatchObject({ index: 2, playing: false, failedCount: 3 })
    usePlayer.getState().toggle()
    expect(usePlayer.getState()).toMatchObject({ playing: true, failedCount: 0, loadVersion: 1 })
  })

  it('播放地址过期后重新解析时保留当前定位，不更换曲目', () => {
    usePlayer.getState().play(catalog[0])
    usePlayer.setState({ position: 90, seekTo: null })
    usePlayer.getState().reloadPlayback()
    expect(usePlayer.getState()).toMatchObject({
      index: 0,
      position: 90,
      seekTo: 90,
      loadVersion: 1,
    })
  })

  it('顺序模式按列表循环前进和后退', () => {
    const list = catalog.slice(0, 4)
    usePlayer.getState().play(list[3], list)
    usePlayer.getState().next()
    expect(usePlayer.getState().index).toBe(0)
    usePlayer.getState().previous()
    expect(usePlayer.getState().index).toBe(3)
  })

  it('随机模式保留当前曲目和进度，按打乱后的队列循环且一轮不重复', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const list = catalog.slice(0, 6)
    usePlayer.getState().play(list[2], list)
    usePlayer.setState({ position: 8, seekTo: null })
    usePlayer.getState().setPlaybackMode('shuffle')
    const shuffled = usePlayer.getState()
    expect(shuffled.queue[shuffled.index]).toBe(list[2])
    expect(shuffled.queue).not.toEqual(list)
    expect(shuffled.position).toBe(8)
    expect(shuffled.seekTo).toBeNull()
    const visited = []
    for (let i = 0; i < list.length; i++) {
      const state = usePlayer.getState()
      visited.push(trackKey(state.queue[state.index]))
      state.next()
    }
    expect(new Set(visited).size).toBe(list.length)
    expect(usePlayer.getState().queue[usePlayer.getState().index]).toBe(list[2])
    usePlayer.getState().setPlaybackMode('sequential')
    expect(usePlayer.getState().queue).toEqual(list)
    expect(usePlayer.getState().index).toBe(2)
  })

  it('随机模式下重新选歌也保留点选歌曲，并恢复对应列表的顺序', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    usePlayer.getState().setPlaybackMode('shuffle')
    const list = catalog.slice(8, 14)
    usePlayer.getState().play(list[3], list)
    expect(usePlayer.getState().queue[0]).toBe(list[3])
    usePlayer.getState().setPlaybackMode('sequential')
    expect(usePlayer.getState().queue).toEqual(list)
    expect(usePlayer.getState().index).toBe(3)
  })

  it('拖动非当前歌曲跨过当前项，不误切歌或重置暂停进度', () => {
    const list = catalog.slice(0, 5)
    usePlayer.getState().play(list[2], list)
    usePlayer.setState({ playing: false, position: 9, seekTo: null })
    usePlayer.getState().move({ ...list[0] }, 4)
    const state = usePlayer.getState()
    expect(state.queue.map(trackKey)).toEqual(
      [list[1], list[2], list[3], list[4], list[0]].map(trackKey),
    )
    expect(state.queue[state.index]).toBe(list[2])
    expect(state).toMatchObject({ position: 9, playing: false, seekTo: null })
    expect(list).toEqual(catalog.slice(0, 5))
  })

  it.each([true, false])('当前歌曲禁止拖动，保留进度和 playing=%s', (playing) => {
    const list = catalog.slice(0, 4)
    usePlayer.getState().play(list[0], list)
    usePlayer.setState({ playing, position: 12, seekTo: null })
    usePlayer.getState().move(list[0], 3)
    expect(usePlayer.getState()).toMatchObject({ index: 0, position: 12, seekTo: null, playing })
    expect(usePlayer.getState().queue).toEqual(list)
  })

  it('切换模式保留暂停状态，删除的歌曲不会在恢复顺序时重新出现', () => {
    const list = catalog.slice(0, 5)
    usePlayer.getState().play(list[2], list)
    usePlayer.setState({ playing: false, position: 7, seekTo: null })
    usePlayer.getState().remove(0)
    usePlayer.getState().setPlaybackMode('shuffle')
    usePlayer.getState().setPlaybackMode('sequential')
    expect(usePlayer.getState().queue).toEqual(list.slice(1))
    expect(usePlayer.getState()).toMatchObject({
      index: 1,
      playing: false,
      position: 7,
      seekTo: null,
    })
  })

  it('使用音源与平台条目共同定位，混源同 ID 不会移动错误歌曲', () => {
    const first = { ...catalog[0], source: 'netease' as const, source_id: 'same-id' }
    const second = { ...catalog[1], source: 'bilibili' as const, source_id: 'same-id' }
    usePlayer.getState().play(first, [first, second])
    usePlayer.getState().move(second, 0)
    expect(usePlayer.getState().queue).toEqual([second, first])
    expect(usePlayer.getState().index).toBe(1)
  })
})
