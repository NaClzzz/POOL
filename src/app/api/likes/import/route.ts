import 'server-only'
export const runtime = 'nodejs'
import { importLikes } from '@/server/likes/handlers'
export const POST = importLikes
export const maxDuration = 120
