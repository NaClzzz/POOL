import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('axios', () => ({ default: { create: () => ({ get }), isAxiosError: () => false } }))
vi.mock('@/server/env', () => ({
  readServerEnv: () => ({ MUSIC_API_BASE_URL: 'http://music-api:3001' }),
}))
vi.mock('@/server/music/runtime', () => ({
  musicCache: (_key: string, _seconds: number, load: () => Promise<unknown>) => load(),
  withMusicBudget: (load: () => Promise<unknown>) => load(),
}))
import { neteaseAdapter } from '@/server/music/adapters/netease'
import { musicService } from '@/server/music/service'

beforeEach(() => {
  get.mockReset()
  get.mockResolvedValue({
    status: 200,
    data: { code: 200, playlist: { id: 3778678, name: '歌单', trackCount: 0, trackIds: [] } },
  })
})

describe('网易云适配器歌单链接边界', () => {
  it.each([
    'https://music.163.com/playlist?id=3778678',
    'https://music.163.com/#/playlist?id=3778678',
    'https://y.music.163.com/m/playlist?id=3778678&userid=1',
  ])('解析正式链接并只访问固定上游 %s', async (url) => {
    const result = await neteaseAdapter.getPlaylistTracks(url, 0, 100)
    expect(result.playlist.source_id).toBe('3778678')
    const upstream = new URL(get.mock.calls[0][0])
    expect(upstream.origin).toBe('http://music-api:3001')
    expect(upstream.pathname).toBe('/playlist/detail')
    expect(upstream.searchParams.get('id')).toBe('3778678')
    expect(get).toHaveBeenCalledOnce()
  })
  it.each([
    'invalid',
    'https://evil.example/playlist?id=1',
    'https://music.163.com.evil.example/playlist?id=1',
    'https://music.163.com/song?id=1',
    'file:///playlist?id=1',
    'https://u:p@music.163.com/playlist?id=1',
    'https://music.163.com/playlist?id=NaN',
  ])('适配器拒绝无效平台链接且不发上游请求 %s', async (url) => {
    await expect(neteaseAdapter.getPlaylistTracks(url, 0, 100)).rejects.toMatchObject({
      code: 'INVALID_PLAYLIST_LINK',
    })
    expect(get).not.toHaveBeenCalled()
  })
  it('未接入音源返回未支持，不调用网易云解析或回退', async () => {
    expect(() =>
      musicService.getPlaylistTracks('bilibili', 'https://www.bilibili.com/list/123', 0, 100),
    ).toThrow(expect.objectContaining({ code: 'CAPABILITY_NOT_SUPPORTED' }))
    expect(get).not.toHaveBeenCalled()
  })
})
