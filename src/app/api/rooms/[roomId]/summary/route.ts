import 'server-only'
import { getSummaryHandler, generateSummaryHandler } from '@/server/ai/handlers'

/** 查询本人有权访问的共享总结状态。 */
export const GET = getSummaryHandler
/** 首次生成共享总结，成功后只返回已有结果。 */
export const POST = generateSummaryHandler
