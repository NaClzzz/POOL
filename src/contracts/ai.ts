import { z } from 'zod'

/** 共享总结的持久状态投影，不包含内部尝试和触发用户。 */
export const roomSummarySchema = z.object({
  roomId: z.string(),
  status: z.enum(['idle', 'generating', 'failed', 'succeeded']),
  content: z.string().nullable(),
  errorCode: z.string().nullable(),
  generatedAt: z.string().nullable(),
  expiresAt: z.string(),
})
/** 空闲表示尚未生成；成功正文由持久查询确认。 */
export type RoomSummaryDto = z.infer<typeof roomSummarySchema>
