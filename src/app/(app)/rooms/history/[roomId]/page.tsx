import { HistoryDetail } from '@/features/room-history/history-pages'

/** 以归档 ID 读取共享总结，避免与实时房间号混用。 */
export default async function SummaryRoute({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params
  return <HistoryDetail roomId={roomId} />
}
