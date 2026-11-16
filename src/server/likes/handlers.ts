import { paginationSchema } from '@/server/http/validation'
import { z } from 'zod'
import { businessRequest } from '../http/business'
import { likesService } from './service'
import { sourceSchema, trackSchema, neteasePlaylistId } from '../music/validation'
import { musicLimit } from '../music/runtime'

/** 收藏 HTTP 入口独立取可信身份，不接受请求提供的用户 ID。 */
export function likesRequest(request: Request) {
  return businessRequest(request, async (userId) => {
    const query = Object.fromEntries(new URL(request.url).searchParams)
    if (request.method === 'GET') {
      const params = paginationSchema.parse(query)
      return { data: await likesService.list(userId, params.offset, params.limit) }
    }
    if (request.method === 'DELETE') {
      const params = z.object({ source: sourceSchema, id: z.string().min(1).max(160) }).parse(query)
      await musicLimit(userId, 'likes-write', 120)
      return { data: await likesService.remove(userId, params.source, params.id) }
    }
    const { track } = z.object({ track: trackSchema }).parse(await request.json())
    await musicLimit(userId, 'likes-write', 120)
    const result = await likesService.add(userId, track)
    return { data: result, status: result.added ? 201 : 200 }
  })
}

/** 导入只读取正式网易云歌单引用；先校验、限流，再占用当前用户租约。 */
export function importLikes(request: Request) {
  return businessRequest(request, async (userId) => {
    const input = z
      .object({ source: z.literal('netease'), url: z.string().max(2048) })
      .parse(await request.json())
    neteasePlaylistId(input.url)
    await musicLimit(userId, 'import', 2, 300, true)
    return { data: await likesService.importPlaylist(userId, input.url) }
  })
}

export function clearLikes(request: Request) {
  return businessRequest(request, async (userId) => {
    await musicLimit(userId, 'likes-write', 120)
    return { data: await likesService.clear(userId) }
  })
}
