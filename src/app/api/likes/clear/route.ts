import 'server-only'
import { clearLikes } from '@/server/likes/handlers'

export const runtime = 'nodejs'

export const DELETE = clearLikes
