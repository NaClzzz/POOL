import 'server-only'
import { musicStream } from '@/server/music/handlers'
export const runtime = 'nodejs'
export const GET = musicStream
