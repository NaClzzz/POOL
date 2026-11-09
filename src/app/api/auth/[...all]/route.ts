import 'server-only'

import { handleAuthRequest } from '@/server/auth/handler'

export const GET = handleAuthRequest
export const POST = handleAuthRequest
