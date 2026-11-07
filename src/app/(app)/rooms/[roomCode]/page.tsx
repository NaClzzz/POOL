import { RoomPage } from '@/features/room/room-page'

/** 使用房间号作为挂载边界，切房时销毁旧会话。 */
export default async function RoomRoute({ params }: { params: Promise<{ roomCode: string }> }) {
  const { roomCode } = await params
  return <RoomPage key={roomCode} code={roomCode} />
}
