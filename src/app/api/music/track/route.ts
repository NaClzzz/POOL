import 'server-only'

import { musicQuery } from '@/server/music/handlers'
/** 按统一平台引用读取详情。 */
export const GET = (request: Request) => musicQuery(request, 'track')
