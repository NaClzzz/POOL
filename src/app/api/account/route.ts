import 'server-only'
import { getAccount } from '@/server/account'

export const runtime = 'nodejs'
export const GET = getAccount
