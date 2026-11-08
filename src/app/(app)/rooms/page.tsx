import { requirePageUser } from '@/server/auth/session'
import { LobbyPage } from '@/features/room/lobby-page'

/** 大厅页面入口。 */
export default async function RoomsRoute() {
  await requirePageUser('/rooms')
  return <LobbyPage />
}
