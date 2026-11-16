import 'server-only'
import { playlistAnalysisHandler } from '@/server/ai/handlers'

/** 从真实收藏生成单次流式赏析。 */
export const POST = playlistAnalysisHandler
