import { paginationSchema } from '@/server/http/validation'
import { describe, expect, it } from 'vitest'
import { trackSchema } from '@/server/music/validation'

describe('音乐入口契约', () => {
  it('入口分页拒绝负值和超过单次上限的查询', () => {
    expect(paginationSchema.parse({})).toEqual({ offset: 0, limit: 20 })
    expect(() => paginationSchema.parse({ offset: -1 })).toThrow()
    expect(() => paginationSchema.parse({ limit: 501 })).toThrow()
  })
  it('收藏契约去掉顶层临时资源及用户指定身份', () => {
    const parsed = trackSchema.parse({
      source: 'netease',
      source_id: '33894312',
      title: null,
      author: null,
      album: null,
      duration_ms: null,
      cover_url: null,
      extra: null,
      url: 'https://example.com/audio',
      userId: 'other-user',
      lrc: 'secret',
    })
    expect(parsed).not.toHaveProperty('url')
    expect(parsed).not.toHaveProperty('userId')
    expect(parsed).not.toHaveProperty('lrc')
  })
})
