import { businessRequest } from '@/server/http/business'
import { deleteHistory, historyDetail } from '@/server/rooms/repository'
/** 路径身份由 Next 提供；权限始终以服务端会话对应历史为准。 */
type Context = { params: Promise<{ roomId: string }> }
/** 归档详情不返回聊天，也不伪造总结。 */
export const GET = (request: Request, context: Context) =>
  businessRequest(request, async (userId) => ({
    data: await historyDetail(userId, (await context.params).roomId),
  }))
/** 删除仅撤销本人凭证。 */
export const DELETE = (request: Request, context: Context) =>
  businessRequest(request, async (userId) => {
    await deleteHistory(userId, (await context.params).roomId)
    return { data: null }
  })
