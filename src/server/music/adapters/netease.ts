import { z } from 'zod'
import type { Track } from '@/contracts/domain'
import type { MusicAdapter } from '../adapter'
import { BusinessError } from '../../http/errors'
import { readServerEnv } from '../../env'
import { musicCache, withMusicBudget } from '../runtime'

/** 上游歌曲最小结构；可缺资料保留 null，身份与已知时长必须有效。 */
const songSchema = z.object({
  id: z.number().int().positive().safe(),
  name: z.string().nullish(),
  dt: z.number().nonnegative().nullish(),
  ar: z.array(z.object({ name: z.string().nullish() })).nullish(),
  al: z.object({ name: z.string().nullish(), picUrl: z.string().nullish() }).nullish(),
})
/** 完整详情响应独立校验，不在业务层猜测平台字段。 */
const detailsSchema = z.object({ songs: z.array(songSchema) })
/** 歌单资料包括原始条目顺序，用于分页读取所需部分。 */
const playlistSchema = z.object({
  playlist: z.object({
    id: z.number().int().positive().safe(),
    name: z.string().nullish(),
    coverImgUrl: z.string().nullish(),
    trackCount: z.number().int().nonnegative(),
    trackIds: z.array(z.object({ id: z.number().int().positive().safe() })),
  }),
})

/** 将唯一平台资料边界转换为统一曲目，额外上游字段不向业务传播。 */
function trackOf(song: z.infer<typeof songSchema>): Track {
  return {
    source: 'netease',
    source_id: String(song.id),
    title: song.name ?? null,
    author:
      song.ar
        ?.map((artist) => artist.name)
        .filter(Boolean)
        .join(' / ') || null,
    album: song.al?.name ?? null,
    duration_ms: song.dt || null,
    cover_url: song.al?.picUrl?.replace(/^http:/, 'https:') ?? null,
    extra: null,
  }
}

/** 平台身份只在适配器入口校验，避免把演示 ID 发给真实平台。 */
function neteaseId(id: string) {
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new BusinessError('INVALID_INPUT', '网易云条目 ID 无效')
  return id
}

/** 网易云 API 业务码与 HTTP 状态统一处理，不透传上游 Cookie 或异常堆栈。 */
async function upstream<T>(
  path: string,
  params: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T> {
  return withMusicBudget(async () => {
    const url = new URL(path, readServerEnv().MUSIC_API_BASE_URL)
    url.search = new URLSearchParams({ ...params, noCookie: 'true' }).toString()
    let response: Response, raw: unknown
    try {
      response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
      raw = await response.json()
    } catch (error) {
      throw new BusinessError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'UPSTREAM_TIMEOUT'
          : 'UPSTREAM_UNAVAILABLE',
        '无法连接网易云音源服务，请稍后重试',
        error instanceof Error && error.name === 'TimeoutError' ? 504 : 502,
      )
    }
    const envelope = z.object({ code: z.number() }).safeParse(raw)
    if (response.status === 429 || (envelope.success && [429, 405].includes(envelope.data.code)))
      throw new BusinessError('UPSTREAM_RATE_LIMITED', '网易云音源请求受限，请稍后重试', 502, 5)
    if (!response.ok || !envelope.success || envelope.data.code !== 200)
      throw new BusinessError('UPSTREAM_UNAVAILABLE', '网易云暂时无法提供该资源', 502)
    const result = schema.safeParse(raw)
    if (!result.success)
      throw new BusinessError('UPSTREAM_INVALID_RESPONSE', '网易云返回的数据格式异常', 502)
    return result.data
  })
}

/** 网易云匿名适配器，全部能力通过统一契约提供，不启用跨源解锁。 */
export const neteaseAdapter: MusicAdapter = {
  search: (q, offset, limit) =>
    musicCache(`netease:search:${encodeURIComponent(q)}:${offset}:${limit}`, 60, async () => {
      const result = await upstream(
        '/cloudsearch',
        { keywords: q, type: '1', offset: String(offset), limit: String(limit) },
        z.object({
          result: z.object({
            songCount: z.number().int().nonnegative().optional(),
            songs: z.array(songSchema).optional(),
          }),
        }),
      )
      const items = (result.result.songs ?? []).map(trackOf)
      const total = result.result.songCount ?? null
      return {
        items,
        offset,
        limit,
        total,
        hasMore:
          total === null ? (items.length === limit ? null : false) : offset + items.length < total,
      }
    }),
  getTrack: (id) =>
    musicCache(`netease:track:${neteaseId(id)}`, 300, async () => {
      const result = await upstream('/song/detail', { ids: id }, detailsSchema)
      const song = result.songs.find((song) => String(song.id) === id)
      if (!song) throw new BusinessError('TRACK_NOT_FOUND', '歌曲不存在', 404)
      return trackOf(song)
    }),
  getLyrics: (id) =>
    musicCache(`netease:lyrics:${neteaseId(id)}`, 86400, async () => {
      const result = await upstream(
        '/lyric',
        { id },
        z.object({
          lrc: z.object({ lyric: z.string().nullish() }).nullish(),
          tlyric: z.object({ lyric: z.string().nullish() }).nullish(),
        }),
      )
      return { lrc: result.lrc?.lyric || null, translationLrc: result.tlyric?.lyric || null }
    }),
  resolvePlayback: async (id) => {
    neteaseId(id)
    const result = await upstream(
      '/song/url/v1',
      { id, level: 'exhigh', unblock: 'true' },
      z.object({
        data: z.array(
          z.object({
            id: z.number(),
            url: z.string().nullable(),
            code: z.number().optional(),
            type: z.string().nullish(),
            expi: z.number().nullish(),
            freeTrialInfo: z.unknown().optional(),
          }),
        ),
      }),
    )
    const item = result.data.find((item) => String(item.id) === id)
    if (
      !item?.url ||
      (item.code !== undefined && item.code !== 200) ||
      (item.freeTrialInfo && item.freeTrialInfo !== 'null')
    )
      throw new BusinessError('TRACK_UNPLAYABLE', '当前歌曲无法匿名完整播放，请选择其他歌曲', 422)
    const url = new URL(item.url)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.music.126.net'))
      throw new BusinessError('TRACK_UNPLAYABLE', '音源未提供可用的网易云播放资源', 422)
    url.protocol = 'https:'
    const track = await neteaseAdapter.getTrack(id)
    return {
      url: url.toString(),
      delivery: 'direct',
      mime_type: item.type === 'mp3' ? 'audio/mpeg' : item.type === 'flac' ? 'audio/flac' : null,
      expires_at: item.expi ? new Date(Date.now() + item.expi * 1000).toISOString() : null,
      duration_ms: track.duration_ms,
    }
  },
  getPlaylistTracks: async (id, offset, limit) => {
    neteaseId(id)
    const result = await musicCache(`netease:playlist:${id}`, 120, () =>
      upstream('/playlist/detail', { id, n: '100000' }, playlistSchema),
    )
    const playlist = result.playlist
    const ids = playlist.trackIds.slice(offset, offset + limit).map((track) => String(track.id))
    const tracks = ids.length
      ? await musicCache(`netease:playlist-page:${id}:${offset}:${limit}`, 120, () =>
          upstream('/song/detail', { ids: ids.join(',') }, detailsSchema),
        )
      : { songs: [] }
    const byId = new Map(tracks.songs.map((song) => [String(song.id), trackOf(song)]))
    return {
      playlist: {
        source: 'netease',
        source_id: id,
        title: playlist.name ?? null,
        cover_url: playlist.coverImgUrl?.replace(/^http:/, 'https:') ?? null,
      },
      tracks: {
        items: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
        offset,
        limit,
        total: playlist.trackIds.length,
        hasMore: offset + limit < playlist.trackIds.length,
      },
    }
  },
}
