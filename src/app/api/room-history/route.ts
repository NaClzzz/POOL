import { businessRequest } from '@/server/http/business'
import { listHistory } from '@/server/rooms/repository'
import { paginationSchema } from '@/server/music/validation'
/** 本人最多五十条有效访问记录，沿用公共分页契约。 */
export const GET = (request: Request) =>
  businessRequest(request, async (userId) => {
    const { offset, limit } = paginationSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    )
    const items = await listHistory(userId)
    return {
      data: {
        items: items.slice(offset, offset + limit),
        offset,
        limit,
        total: items.length,
        hasMore: offset + limit < items.length,
      },
    }
  })
