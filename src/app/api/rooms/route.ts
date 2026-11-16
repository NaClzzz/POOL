import 'server-only'

import { listRoomsHandler, createRoomHandler } from '@/server/rooms/handlers'

export const GET = listRoomsHandler
export const POST = createRoomHandler
