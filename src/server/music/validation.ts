import { z } from 'zod'

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
