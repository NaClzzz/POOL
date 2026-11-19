import { randomUUID } from 'node:crypto'
import {
  and,
  eq,
  lt,
  desc,
  asc,
  gt,
  gte,
  or,
  isNull,
  ilike,
  inArray,
  sql,
  count,
} from 'drizzle-orm'
import { db } from '../db'
import { user } from '../db/schema'
import { likedSongs } from '../db/likes-schema'
import {
  rooms,
  roomMembers,
  roomHistory,
  roomPlaylistItems,
  roomPlaybackStates,
  roomMessages,
  roomPlayedSongs,
} from '../db/rooms-schema'
import type { Track } from '@/contracts/domain'
import type { Room, RoomPlaylistItem, Playback, ChatMessage } from '@/contracts/room'

/** 房间数据库行仅在服务端使用。 */
export type RoomRow = typeof rooms.$inferSelect
/** 显式投影安全字段，不展开数据库行。 */
export function roomDto(row: RoomRow, ownerName: string): Room {
  return {
    roomId: row.id,
    roomCode: row.code,
    name: row.name,
    tag: row.tag,
    ownerId: row.ownerId,
    ownerName,
    createdBy: row.createdBy,
    memberCount: row.memberCount,
    maxMembers: row.maxMembers,
    maxStageMembers: row.maxStageMembers,
    isPasswordProtected: !!row.passwordHash,
    lastActiveAt: row.lastActiveAt.toISOString(),
    status: row.status,
    endedAt: row.endedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }
}
/** 按房间号取得活动记录或归档。 */
export async function findRoom(code: string) {
  return (await db.select().from(rooms).where(eq(rooms.code, code)))[0]
}
/** 展示房主昵称；账号删除尚不属于当前功能。 */
export async function safeRoom(row: RoomRow) {
  return roomDto(
    row,
    (await db.select({ name: user.name }).from(user).where(eq(user.id, row.ownerId)))[0]?.name ??
      '',
  )
}
/** 创建参数由 Service 准备；用户锁内检查已有记录，防止跨进程重复创建。 */
export async function createRoom(
  input: typeof rooms.$inferInsert,
  assertCanCreate: (owned: RoomRow[]) => void,
) {
  return db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, input.ownerId)).for('update')
    const owned = await tx.select().from(rooms).where(eq(rooms.ownerId, input.ownerId))
    assertCanCreate(owned)
    const [row] = await tx.insert(rooms).values(input).returning()
    return row
  })
}
/** Service 提供大厅有效性和密码房可见策略，数据层仅转换成 SQL 条件。 */
export type RoomListPolicy = {
  status: RoomRow['status']
  minMemberCount: number
  emptyExpiresAfter: Date
  publicOnly: boolean
}
/** 大厅按房间名、标签或完整房间号查询，在数据库按策略筛选后分页。 */
export async function listRooms(
  userId: string,
  q: string,
  offset: number,
  limit: number,
  policy: RoomListPolicy,
) {
  const active = and(
    eq(rooms.status, policy.status),
    or(
      gte(rooms.memberCount, policy.minMemberCount),
      gt(rooms.emptyExpiresAt, policy.emptyExpiresAfter),
    ),
  )
  const visibility = policy.publicOnly ? isNull(rooms.passwordHash) : undefined
  const rows = await db
    .select()
    .from(rooms)
    .where(
      and(
        active,
        q
          ? or(
              eq(rooms.code, q),
              and(visibility, or(ilike(rooms.name, `%${q}%`), ilike(rooms.tag, `%${q}%`))),
            )
          : visibility,
      ),
    )
    .orderBy(desc(rooms.lastActiveAt), asc(rooms.id))
    .limit(limit + 1)
    .offset(offset)
  const mine = (
    await db
      .select()
      .from(rooms)
      .where(and(active, eq(rooms.ownerId, userId)))
      .orderBy(desc(rooms.lastActiveAt))
      .limit(1)
  )[0]
  return {
    rooms: {
      items: await Promise.all(rows.slice(0, limit).map(safeRoom)),
      offset,
      limit,
      total: null,
      hasMore: rows.length > limit,
    },
    myRoom: mine ? await safeRoom(mine) : null,
  }
}
/** 用户锁内原子保存投影与历史；淘汰哪些凭证由 Service 决定。 */
export async function recordJoin(
  row: RoomRow,
  userId: string,
  count: number,
  joinedAt: Date,
  selectHistoryToRemove: (roomIds: string[]) => string[],
) {
  await db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update')
    await tx
      .insert(roomMembers)
      .values({ roomId: row.id, userId, joinedAt, leftAt: null })
      .onConflictDoUpdate({
        target: [roomMembers.roomId, roomMembers.userId],
        set: { joinedAt, leftAt: null },
      })
    await tx
      .insert(roomHistory)
      .values({ roomId: row.id, userId, firstJoinedAt: joinedAt, lastJoinedAt: new Date() })
      .onConflictDoUpdate({
        target: [roomHistory.userId, roomHistory.roomId],
        set: { lastJoinedAt: new Date() },
      })
    const old = await tx
      .select({ id: roomHistory.roomId })
      .from(roomHistory)
      .where(eq(roomHistory.userId, userId))
      .orderBy(desc(roomHistory.lastJoinedAt), asc(roomHistory.roomId))
    const removed = selectHistoryToRemove(old.map((r) => r.id))
    if (removed.length)
      await tx
        .delete(roomHistory)
        .where(and(eq(roomHistory.userId, userId), inArray(roomHistory.roomId, removed)))
    await tx
      .update(rooms)
      .set({ memberCount: count, lastActiveAt: new Date() })
      .where(eq(rooms.id, row.id))
  })
}
/** 读取本人历史及房间资料；有效期和对外投影交给 Service。 */
export async function listHistory(userId: string) {
  return db
    .select({ room: rooms, joined: roomHistory.lastJoinedAt, name: user.name })
    .from(roomHistory)
    .innerJoin(rooms, eq(rooms.id, roomHistory.roomId))
    .innerJoin(user, eq(user.id, rooms.ownerId))
    .where(eq(roomHistory.userId, userId))
    .orderBy(desc(roomHistory.lastJoinedAt), asc(rooms.id))
}
/** 参与者取成功加入记录，不随个人历史删除而减少；计数只读取保留记录。 */
export async function historyActivity(roomId: string) {
  const [participants, [played], [messages]] = await Promise.all([
    db
      .select({ userId: user.id, name: user.name, image: user.image })
      .from(roomMembers)
      .innerJoin(user, eq(user.id, roomMembers.userId))
      .where(eq(roomMembers.roomId, roomId))
      .orderBy(asc(roomMembers.joinedAt), asc(user.id)),
    db.select({ total: count() }).from(roomPlayedSongs).where(eq(roomPlayedSongs.roomId, roomId)),
    db.select({ total: count() }).from(roomMessages).where(eq(roomMessages.roomId, roomId)),
  ])
  return { participants, playedCount: played.total, messageCount: messages.total }
}
/** 删除只撤销当前用户的访问凭证。 */
export async function deleteHistory(userId: string, roomId: string) {
  await db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update')
    await tx
      .delete(roomHistory)
      .where(and(eq(roomHistory.userId, userId), eq(roomHistory.roomId, roomId)))
  })
}
/** 查询当前用户的持久房间歌单。 */
export async function getPlaylist(userId: string): Promise<RoomPlaylistItem[]> {
  return (
    await db
      .select()
      .from(roomPlaylistItems)
      .where(eq(roomPlaylistItems.userId, userId))
      .orderBy(asc(roomPlaylistItems.position), asc(roomPlaylistItems.id))
  ).map((r) => ({ itemId: r.id, position: r.position, track: r.track }))
}
/** 统一用户事务锁下替换歌单；位置由数组顺序生成。 */
export async function editPlaylist(
  userId: string,
  edit: (items: RoomPlaylistItem[]) => RoomPlaylistItem[],
) {
  return db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update')
    const old = (
      await tx
        .select()
        .from(roomPlaylistItems)
        .where(eq(roomPlaylistItems.userId, userId))
        .orderBy(asc(roomPlaylistItems.position), asc(roomPlaylistItems.id))
    ).map((r) => ({ itemId: r.id, position: r.position, track: r.track }))
    const next = edit(old).map((item, position) => ({ ...item, position }))
    await tx.delete(roomPlaylistItems).where(eq(roomPlaylistItems.userId, userId))
    if (next.length)
      await tx.insert(roomPlaylistItems).values(
        next.map((item) => ({
          id: item.itemId,
          userId,
          position: item.position,
          source: item.track.source,
          sourceId: item.track.source_id,
          track: item.track,
        })),
      )
    return next
  })
}
/** 导入只读取当前用户的服务端收藏快照。 */
export async function likedTracks(userId: string): Promise<Track[]> {
  return db
    .select()
    .from(likedSongs)
    .where(eq(likedSongs.userId, userId))
    .orderBy(desc(likedSongs.addedAt))
}
/** 已提交消息的最近两百条用于加入快照。 */
export async function recentMessages(roomId: string): Promise<ChatMessage[]> {
  return (
    await db
      .select()
      .from(roomMessages)
      .where(eq(roomMessages.roomId, roomId))
      .orderBy(desc(roomMessages.createdAt), desc(roomMessages.id))
      .limit(200)
  )
    .reverse()
    .map((r) => ({
      id: r.id,
      roomId,
      senderId: r.userId,
      senderName: r.senderName,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
    }))
}
/** 消息先持久化再广播，同事务淘汰最旧超额消息。 */
export async function appendMessage(message: ChatMessage) {
  await db.transaction(async (tx) => {
    await tx.insert(roomMessages).values({
      id: message.id,
      roomId: message.roomId,
      userId: message.senderId,
      senderName: message.senderName,
      content: message.content,
      createdAt: new Date(message.createdAt),
    })
    await tx.execute(
      sql`delete from room_messages where room_id=${message.roomId} and id in (select id from room_messages where room_id=${message.roomId} order by created_at desc,id desc offset 10000)`,
    )
  })
}
/** 时间轴投影一次写入；不逐秒持久化进度。 */
export async function savePlayback(playback: Playback, activeIndex: number) {
  await db
    .insert(roomPlaybackStates)
    .values({ roomId: playback.roomId, playback, activeIndex })
    .onConflictDoUpdate({ target: roomPlaybackStates.roomId, set: { playback, activeIndex } })
}
/** 仅记录实际已经到达起播锚点的节目，版本唯一避免重复。 */
export async function recordPlayed(playback: Playback) {
  await db.transaction(async (tx) => {
    await tx
      .insert(roomPlayedSongs)
      .values({
        id: randomUUID(),
        roomId: playback.roomId,
        memberId: playback.activeMemberId!,
        track: playback.track!,
        playbackVersion: playback.version,
        playedAt: new Date(playback.startedAt!),
      })
      .onConflictDoNothing()
    await tx.execute(
      sql`delete from room_played_songs where room_id=${playback.roomId} and id in (select id from room_played_songs where room_id=${playback.roomId} order by played_at desc,id desc offset 500)`,
    )
  })
}

/** 启动时在同一事务重置在线投影和各房间的等待时间轴。 */
export async function resetOnlineState(
  emptyExpiresAt: Date,
  resetPlayback: (saved: Playback) => Playback,
) {
  await db.transaction(async (tx) => {
    await tx.update(roomMembers).set({ leftAt: new Date() }).where(isNull(roomMembers.leftAt))
    await tx
      .update(rooms)
      .set({ memberCount: 0, emptyExpiresAt })
      .where(and(eq(rooms.status, 'active'), sql`${rooms.memberCount} > 0`))
    const states = await tx.select().from(roomPlaybackStates)
    for (const state of states) {
      await tx
        .update(roomPlaybackStates)
        .set({ activeIndex: -1, playback: resetPlayback(state.playback) })
        .where(eq(roomPlaybackStates.roomId, state.roomId))
    }
  })
}
/** 按房间身份读取持久播放投影。 */
export async function getPlayback(roomId: string) {
  return (
    await db.select().from(roomPlaybackStates).where(eq(roomPlaybackStates.roomId, roomId))
  )[0]
}
/** 保存 Service 已校验的房间设置或在线摘要，返回数据库实际记录。 */
export async function updateRoom(roomId: string, changes: Partial<Omit<RoomRow, 'id' | 'code'>>) {
  return (await db.update(rooms).set(changes).where(eq(rooms.id, roomId)).returning())[0]
}
/** 退出投影与房间摘要在同一事务提交，房主及截止时间由 Service 决定。 */
export async function recordLeave(
  roomId: string,
  userId: string,
  leftAt: Date,
  changes: Pick<RoomRow, 'memberCount' | 'ownerId' | 'lastActiveAt'> &
    Partial<Pick<RoomRow, 'emptyExpiresAt'>>,
) {
  return db.transaction(async (tx) => {
    await tx
      .update(roomMembers)
      .set({ leftAt })
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    return (await tx.update(rooms).set(changes).where(eq(rooms.id, roomId)).returning())[0]
  })
}
/** 归档房间、关闭成员投影与清空播放时间轴原子提交。 */
export async function archiveRoom(
  roomId: string,
  endedAt: Date,
  expiresAt: Date,
  playback: Playback,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(rooms)
      .set({ status: 'ended', memberCount: 0, endedAt, expiresAt })
      .where(eq(rooms.id, roomId))
    await tx.update(roomMembers).set({ leftAt: endedAt }).where(eq(roomMembers.roomId, roomId))
    await tx
      .insert(roomPlaybackStates)
      .values({ roomId, playback, activeIndex: -1 })
      .onConflictDoUpdate({ target: roomPlaybackStates.roomId, set: { playback, activeIndex: -1 } })
  })
}
/** 按 Service 提供的时刻筛选待处理空房，不自行决定有效期。 */
export async function findEmptyRoomsBefore(deadline: Date) {
  return db
    .select()
    .from(rooms)
    .where(
      and(eq(rooms.status, 'active'), eq(rooms.memberCount, 0), lt(rooms.emptyExpiresAt, deadline)),
    )
}
/** 级联删除 Service 已确认到期的归档记录。 */
export async function deleteArchivesBefore(deadline: Date) {
  await db.delete(rooms).where(and(eq(rooms.status, 'ended'), lt(rooms.expiresAt, deadline)))
}
