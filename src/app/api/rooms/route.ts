import { businessRequest } from '@/server/http/business'
import { paginationSchema } from '@/server/music/validation'
import { createRoomSchema } from '@/server/rooms/validation'
import { createRoom, listRooms } from '@/server/rooms/repository'
/** 大厅读取安全房间摘要，在线投影只供展示。 */
export const GET = (request: Request) =>
  businessRequest(request, async (userId) => {
    const params = new URL(request.url).searchParams
    const { offset, limit } = paginationSchema.parse(Object.fromEntries(params))
    return { data: await listRooms(userId, (params.get('q') ?? '').slice(0, 100), offset, limit) }
  })
/** HTTP 只负责创建，实际加入和其余房间变更由 Socket 处理。 */
export const POST = (request: Request) =>
  businessRequest(request, async (userId) => ({
    data: await createRoom(userId, createRoomSchema.parse(await request.json())),
    status: 201,
  }))
