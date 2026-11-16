import { z } from 'zod'
import { BusinessError } from '../http/errors'

/** 来源仅表达平台身份，接口实现名称不能成为歌曲身份。 */
export const sourceSchema = z.enum(['netease', 'bilibili'])
/** 请求入口的统一歌曲引用。平台专用身份由对应适配器解释。 */
export const referenceSchema = z.object({
  source: sourceSchema,
  source_id: z.string().trim().min(1).max(160),
  extra: z.record(z.string(), z.unknown()).nullable().optional(),
})
/** 收藏资料仅保留契约字段，禁止夹带播放 URL 和歌词。 */
export const trackSchema = referenceSchema.extend({
  title: z.string().max(1000).nullable(),
  author: z.string().max(1000).nullable(),
  album: z.string().max(1000).nullable(),
  duration_ms: z.number().int().positive().nullable(),
  cover_url: z
    .url()
    .regex(/^https?:/)
    .nullable(),
  extra: z.record(z.string(), z.unknown()).nullable(),
})
/** 只解析网易云正式分享地址中的歌单 ID，不向用户指定的地址发请求。 */
export function neteasePlaylistId(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BusinessError('INVALID_PLAYLIST_LINK', '请输入网易云歌单链接')
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !['music.163.com', 'y.music.163.com'].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port))
  )
    throw new BusinessError('INVALID_PLAYLIST_LINK', '请使用 music.163.com 的完整歌单链接')
  const path = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url
  const id = path.searchParams.get('id')
  if (!/\/(?:m\/)?playlist\/?$/.test(path.pathname) || !id || !/^[1-9]\d{0,19}$/.test(id))
    throw new BusinessError('INVALID_PLAYLIST_LINK', '歌单链接需要包含有效的 playlist?id=...')
  return id
}
