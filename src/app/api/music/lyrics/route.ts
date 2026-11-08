import 'server-only'
export const runtime = 'nodejs'
import { musicQuery } from '@/server/music/handlers'
/** 歌词独立读取，无歌词和上游错误分开。 */
export const GET = (request: Request) => musicQuery(request, 'lyrics')
