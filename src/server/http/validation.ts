import { z } from 'zod'

/** 统一分页入口最多读取 500 条。 */
export const paginationSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(20),
})
