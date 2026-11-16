import { businessRequest } from '../http/business'
import { paginationSchema } from '../http/validation'
import { createRoomSchema } from './validation'
import * as service from './service'

/** 历史详情路由参数由 Next 提供，访问身份仍取自服务端会话。 */
type HistoryContext = { params: Promise<{ roomId: string }> }

/** 大厅入口只校验查询参数，房间可见性由 Service 决定。 */
export function listRoomsHandler(request: Request) {
  return businessRequest(request, async (userId) => {
    const params = new URL(request.url).searchParams
    const { offset, limit } = paginationSchema.parse(Object.fromEntries(params))
    return {
      data: await service.listRooms(userId, (params.get('q') ?? '').slice(0, 100), offset, limit),
    }
  })
}

/** 创建入口校验请求体；实际加入及实时变更通过 Socket 执行。 */
export function createRoomHandler(request: Request) {
  return businessRequest(request, async (userId) => ({
    data: await service.createRoom(userId, createRoomSchema.parse(await request.json())),
    status: 201,
  }))
}

/** 本人有效历史使用公共分页契约，保留精确总数。 */
export function listRoomHistoryHandler(request: Request) {
  return businessRequest(request, async (userId) => {
    const { offset, limit } = paginationSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    )
    const items = await service.listHistory(userId)
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
}

/** 读取本人仍持有有效凭证的历史详情，不返回原始聊天或模拟总结。 */
export function getRoomHistoryHandler(request: Request, context: HistoryContext) {
  return businessRequest(request, async (userId) => ({
    data: await service.historyDetail(userId, (await context.params).roomId),
  }))
}

/** 删除只撤销本人凭证，事务协调交由 Service 与 Repository。 */
export function deleteRoomHistoryHandler(request: Request, context: HistoryContext) {
  return businessRequest(request, async (userId) => {
    await service.deleteHistory(userId, (await context.params).roomId)
    return { data: null }
  })
}
