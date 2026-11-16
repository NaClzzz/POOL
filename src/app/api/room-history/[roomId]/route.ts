import 'server-only'

import { getRoomHistoryHandler, deleteRoomHistoryHandler } from '@/server/rooms/handlers'

export const GET = getRoomHistoryHandler
export const DELETE = deleteRoomHistoryHandler
