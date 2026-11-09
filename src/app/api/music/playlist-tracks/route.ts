import 'server-only'

import { musicQuery } from '@/server/music/handlers'
/** 分页读取歌单，不修改喜欢。 */
export const GET = (request: Request) => musicQuery(request, 'playlist')
