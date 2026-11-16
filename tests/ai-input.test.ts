import { describe, expect, it, vi } from 'vitest'
import { cleanLyrics, sampleLyrics, playlistPrompt, summaryPrompt } from '@/server/ai/prompts'
import { catalog } from './fixtures/tracks'

describe('AI 输入与歌词抽样', () => {
  it('清理 LRC 标签，收藏截取千字，房间保留完整歌词', () => {
    const lrc = '[ar:作者]\n[00:01.00]' + '歌'.repeat(1600) + '\n[00:02.00]结尾'
    expect(cleanLyrics(lrc, 1000)).toHaveLength(1000)
    expect(cleanLyrics(lrc)).toBe('歌'.repeat(1600) + '\n结尾')
  })
  it('去重候选，最多尝试十首并取五首完整歌词', async () => {
    const tracks = Array.from({ length: 15 }, (_, i) => ({ ...catalog[0], source_id: String(i) }))
    const load = vi.fn(async () => ({ lrc: '[00:00]完整歌词', translationLrc: '不使用翻译' }))
    const samples = await sampleLyrics([...tracks, ...tracks], load, new AbortController().signal)
    expect(samples).toHaveLength(5)
    expect(load.mock.calls.length).toBeLessThanOrEqual(10)
    expect(samples.every((s) => s.lyrics === '完整歌词')).toBe(true)
    expect(
      samples.every((s) => s.author === catalog[0].author && s.album === catalog[0].album),
    ).toBe(true)
  })
  it('上游失败和无歌词允许降级，但不吞取消信号', async () => {
    const tracks = [catalog[0], { ...catalog[0], source_id: 'other' }]
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('上游错误'))
      .mockResolvedValue({ lrc: null })
    expect(await sampleLyrics(tracks, load, new AbortController().signal)).toEqual([])
    const controller = new AbortController()
    controller.abort()
    await expect(sampleLyrics(tracks, load, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
  it('完整传入歌名、歌手、专辑、重复播放与完整聊天，缺失资料保留 null', () => {
    const tracks = [catalog[0], catalog[0], { ...catalog[1], author: null, album: null }]
    const messages = [{ sender: '甲', content: '聊'.repeat(13000) }]
    const parsed = JSON.parse(summaryPrompt(tracks, messages, []).split('\n')[1])
    const expected = tracks.map(({ title, author, album }) => ({ title, author, album }))
    expect(parsed.tracks).toEqual(expected)
    expect(parsed.messages[0].content).toHaveLength(13000)
    expect(JSON.parse(playlistPrompt(tracks, []).split('\n')[1]).tracks).toEqual(expected)
  })
})
