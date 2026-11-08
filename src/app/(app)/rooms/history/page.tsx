import { requirePageUser } from '@/server/auth/session'
import { HistoryPage } from '@/features/room-history/history-pages'

/** 当前用户的房间历史入口。 */
export default async function HistoryRoute() {
  await requirePageUser('/rooms/history')
  return <HistoryPage />
}
