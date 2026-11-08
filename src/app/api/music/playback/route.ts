import 'server-only'
export const runtime = 'nodejs'
import { musicPlayback } from '@/server/music/handlers'
export const POST = musicPlayback
