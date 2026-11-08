import 'server-only'
export const runtime = 'nodejs'
import { likesRequest } from '@/server/likes/handlers'
export const GET = likesRequest
export const POST = likesRequest
export const DELETE = likesRequest
