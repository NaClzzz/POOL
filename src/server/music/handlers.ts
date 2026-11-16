import { paginationSchema } from '@/server/http/validation'
import { z } from 'zod'
import { businessRequest } from '../http/business'
import { musicService } from './service'
import { musicLimit } from './runtime'
import { sourceSchema, referenceSchema } from './validation'
import { BusinessError } from '../http/errors'

/** GET 音乐查询在一个入口统一校验分页、来源和参数。 */
export function musicQuery(
  request: Request,
  operation: 'search' | 'track' | 'lyrics' | 'playlist',
) {
  return businessRequest(request, async (userId) => {
    const values = Object.fromEntries(new URL(request.url).searchParams)
    if (operation === 'search') {
      const params = paginationSchema
        .extend({ source: sourceSchema, q: z.string().trim().min(1).max(80) })
        .parse(values)
      await musicLimit(userId, `search:${params.source}`, 30)
      return {
        data: await musicService.search(params.source, params.q, params.offset, params.limit),
      }
    }
    if (operation === 'playlist') {
      const params = paginationSchema
        .extend({ source: sourceSchema, url: z.string().max(2048) })
        .parse(values)
      await musicLimit(userId, `playlist:${params.source}`, 10)
      return {
        data: await musicService.getPlaylistTracks(
          params.source,
          params.url,
          params.offset,
          params.limit,
        ),
      }
    }
    const params = z.object({ source: sourceSchema, id: z.string().min(1).max(160) }).parse(values)
    await musicLimit(userId, `details:${params.source}`, 120)
    return {
      data:
        operation === 'track'
          ? await musicService.getTrack(params.source, params.id)
          : await musicService.getLyrics(params.source, params.id),
    }
  })
}

/** 解析播放资源只接受平台引用，不持久化或广播临时地址。 */
export function musicPlayback(request: Request) {
  return businessRequest(request, async (userId) => {
    const ref = referenceSchema.parse(await request.json())
    await musicLimit(userId, `playback:${ref.source}`, 30)
    return {
      data: await musicService.resolvePlayback(ref.source, ref.source_id, ref.extra ?? null),
    }
  })
}

/** 音频代理只解析平台引用，透传单段 Range；不接收客户端任意远程 URL。 */
export function musicStream(request: Request) {
  return businessRequest(request, async (userId) => {
    const params = z
      .object({ source: sourceSchema, id: z.string().min(1).max(160) })
      .parse(Object.fromEntries(new URL(request.url).searchParams))
    const range = request.headers.get('range')
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
      throw new BusinessError('INVALID_RANGE', '不支持该音频分段请求', 416)
    await musicLimit(userId, `playback:${params.source}`, 30)
    const resource = await musicService.resolvePlayback(params.source, params.id)
    let upstream: Response
    try {
      upstream = await fetch(resource.url, {
        headers: range ? { Range: range } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        cache: 'no-store',
      })
    } catch {
      throw new BusinessError('UPSTREAM_UNAVAILABLE', '音频暂时无法读取，请稍后重试', 502)
    }
    if (![200, 206, 416].includes(upstream.status))
      throw new BusinessError('UPSTREAM_UNAVAILABLE', '音频暂时无法读取', 502)
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name)
      if (value) headers.set(name, value)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  })
}
