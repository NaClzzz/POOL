import { and, desc, eq, gt, lte } from 'drizzle-orm'
import { db } from '../db'
import { user } from '../db/schema'
import { rooms, roomHistory, roomMessages, roomPlayedSongs } from '../db/rooms-schema'
import { roomSummaries } from '../db/ai-schema'

/** 总结状态仅供服务端判断尝试与生成资格。 */
export type SummaryRow = typeof roomSummaries.$inferSelect
/** 归档、本人凭证与当前总结，业务规则由 Service 决定。 */
export type SummaryAccess = {
  room: typeof rooms.$inferSelect | undefined
  hasHistory: boolean
  summary: SummaryRow | undefined
}

/** 查询总结使用无锁读取，避免多人查看或轮询互相阻塞。 */
export async function readSummary(userId: string, roomId: string): Promise<SummaryAccess> {
  const [[room], [history], [summary]] = await Promise.all([
    db.select().from(rooms).where(eq(rooms.id, roomId)),
    db
      .select({ roomId: roomHistory.roomId })
      .from(roomHistory)
      .where(and(eq(roomHistory.roomId, roomId), eq(roomHistory.userId, userId))),
    db.select().from(roomSummaries).where(eq(roomSummaries.roomId, roomId)),
  ])
  return { room, hasHistory: !!history, summary }
}

/** 仅对超期的生成尝试执行条件更新，不阻塞正常查询。 */
export async function recoverTimedOutSummary(roomId: string, attemptId: string, cutoff: Date) {
  await db
    .update(roomSummaries)
    .set({ status: 'failed', content: null, errorCode: 'AI_TIMEOUT' })
    .where(
      and(
        eq(roomSummaries.roomId, roomId),
        eq(roomSummaries.attemptId, attemptId),
        eq(roomSummaries.status, 'generating'),
        lte(roomSummaries.startedAt, cutoff),
      ),
    )
}

/** 认领生成资格时与历史删除共用用户锁并锁定房间，保证同房互斥。 */
export async function claimSummary<T>(
  userId: string,
  roomId: string,
  decide: (access: SummaryAccess) => { value: T; write?: typeof roomSummaries.$inferInsert },
) {
  return db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update')
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update')
    const [history] = await tx
      .select({ roomId: roomHistory.roomId })
      .from(roomHistory)
      .where(and(eq(roomHistory.roomId, roomId), eq(roomHistory.userId, userId)))
    const [summary] = await tx.select().from(roomSummaries).where(eq(roomSummaries.roomId, roomId))
    const result = decide({ room, hasHistory: !!history, summary })
    if (result.write)
      await tx
        .insert(roomSummaries)
        .values(result.write)
        .onConflictDoUpdate({ target: roomSummaries.roomId, set: result.write })
    return result.value
  })
}

/** 最新二百个实际节目与最新二百条完整聊天；对模型按时间正序提供。 */
export async function summaryInput(roomId: string) {
  const [songs, messages] = await Promise.all([
    db
      .select({ track: roomPlayedSongs.track })
      .from(roomPlayedSongs)
      .where(eq(roomPlayedSongs.roomId, roomId))
      .orderBy(desc(roomPlayedSongs.playedAt), desc(roomPlayedSongs.id))
      .limit(200),
    db
      .select({ sender: roomMessages.senderName, content: roomMessages.content })
      .from(roomMessages)
      .where(eq(roomMessages.roomId, roomId))
      .orderBy(desc(roomMessages.createdAt), desc(roomMessages.id))
      .limit(200),
  ])
  return { tracks: songs.reverse().map((song) => song.track), messages: messages.reverse() }
}

/** 完成时再次锁房间并检查有效期，只更新仍属于当前尝试的生成记录。 */
export async function finishSummary(
  roomId: string,
  attemptId: string,
  content: string | null,
  errorCode: string | null,
) {
  return db.transaction(async (tx) => {
    const [room] = await tx
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.id, roomId), gt(rooms.expiresAt, new Date())))
      .for('update')
    if (!room) return false
    const changed = await tx
      .update(roomSummaries)
      .set({
        status: content === null ? 'failed' : 'succeeded',
        content,
        errorCode,
        generatedAt: content === null ? null : new Date(),
      })
      .where(
        and(
          eq(roomSummaries.roomId, roomId),
          eq(roomSummaries.attemptId, attemptId),
          eq(roomSummaries.status, 'generating'),
          gt(roomSummaries.startedAt, new Date(Date.now() - 120_000)),
        ),
      )
      .returning({ id: roomSummaries.roomId })
    return changed.length === 1
  })
}
