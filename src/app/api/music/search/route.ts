import 'server-only'
export const runtime = 'nodejs'
import { musicQuery } from '@/server/music/handlers'
/** 通过统一音乐服务进行源内搜索。 */
export const GET = (request: Request) => musicQuery(request, 'search')
