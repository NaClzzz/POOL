import { randomBytes, randomUUID } from 'node:crypto'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { and, eq, desc, asc, gt, or, isNull, ilike, inArray, sql } from 'drizzle-orm'
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
import { BusinessError } from '../http/errors'
import type {
  CreateRoom,
  Room,
  RoomHistory,
  RoomPlaylistItem,
  Playback,
  ChatMessage,
} from '@/contracts/room'
import type { Track } from '@/contracts/domain'

/** 房间数据库行仅在服务端使用。 */
export type RoomRow = typeof rooms.$inferSelect
export const EMPTY_ROOM_MS = 30 * 60_000
export const ARCHIVE_MS = 7 * 24 * 60 * 60_000
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
/** 创建和历史操作复用用户行锁，跨 Web/Socket 进程协调。 */
export async function createRoom(userId: string, input: CreateRoom) {
  const passwordHash = input.password ? await hashPassword(input.password) : null
  return db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update')
    const existing = await tx
      .select()
      .from(rooms)
      .where(
        and(
          eq(rooms.ownerId, userId),
          eq(rooms.status, 'active'),
          or(gt(rooms.memberCount, 0), gt(rooms.emptyExpiresAt, new Date())),
        ),
      )
    if (existing.length)
      throw new BusinessError('ROOM_ALREADY_CREATED', '你已有有效房间，请进入我的房间', 409)
    const [row] = await tx
      .insert(rooms)
      .values({
        id: randomUUID(),
        code: `pool-${randomBytes(8).toString('hex')}`,
        ownerId: userId,
        createdBy: userId,
        name: input.name,
        tag: input.tag,
        maxMembers: input.maxMembers,
        maxStageMembers: input.maxStageMembers,
        passwordHash,
        emptyExpiresAt: new Date(Date.now() + EMPTY_ROOM_MS),
      })
      .returning()
    return safeRoom(row)
  })
}
/** 大厅只列公开活动房；输入完整房间号时可取得密码房安全摘要。 */
export async function listRooms(userId: string, q: string, offset: number, limit: number) {
  const active = and(
    eq(rooms.status, 'active'),
    or(gt(rooms.memberCount, 0), gt(rooms.emptyExpiresAt, new Date())),
  )
  const rows = await db
    .select()
    .from(rooms)
    .where(
      and(
        active,
        q
          ? or(
              eq(rooms.code, q),
              and(
                isNull(rooms.passwordHash),
                or(ilike(rooms.name, `%${q}%`), ilike(rooms.tag, `%${q}%`)),
              ),
            )
          : isNull(rooms.passwordHash),
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
/** 密码检查在变更旧房间之前完成。 */
export async function checkPassword(row: RoomRow, password?: string) {
  if (
    row.passwordHash &&
    (!password || !(await verifyPassword({ hash: row.passwordHash, password })))
  )
    throw new BusinessError(
      'ROOM_PASSWORD_REQUIRED',
      password ? '房间密码不正确' : '请输入房间密码',
      403,
    )
}
/** 成功加入时原子保存投影和历史，并淘汰超出五十条的凭证。 */
export async function recordJoin(row: RoomRow, userId: string, count: number, joinedAt: Date) {
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
      .offset(50)
    if (old.length)
      await tx.delete(roomHistory).where(
        and(
          eq(roomHistory.userId, userId),
          inArray(
            roomHistory.roomId,
            old.map((r) => r.id),
          ),
        ),
      )
    await tx
      .update(rooms)
      .set({ memberCount: count, lastActiveAt: new Date() })
      .where(eq(rooms.id, row.id))
  })
}
/** 本人历史排除已经到期的归档。 */
export async function listHistory(userId: string): Promise<RoomHistory[]> {
  const rows = await db
    .select({ room: rooms, joined: roomHistory.lastJoinedAt, name: user.name })
    .from(roomHistory)
    .innerJoin(rooms, eq(rooms.id, roomHistory.roomId))
    .innerJoin(user, eq(user.id, rooms.ownerId))
    .where(
      and(
        eq(roomHistory.userId, userId),
        or(isNull(rooms.expiresAt), gt(rooms.expiresAt, new Date())),
      ),
    )
    .orderBy(desc(roomHistory.lastJoinedAt), asc(rooms.id))
  return rows.map((r) => ({ ...roomDto(r.room, r.name), lastJoinedAt: r.joined.toISOString() }))
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
/** 历史详情复用有效凭证查询，不以活动成员或房主权限替代。 */
export async function historyDetail(userId: string, roomId: string) {
  const row = (await listHistory(userId)).find((r) => r.roomId === roomId)
  if (!row) throw new BusinessError('ROOM_HISTORY_REQUIRED', '房间已到期或没有访问记录', 403)
  return row
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
    if (next.length > 500)
      throw new BusinessError('PLAYLIST_LIMIT_REACHED', '房间歌单最多 500 首', 409)
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
  if (
    !playback.track ||
    !playback.activeMemberId ||
    !playback.startedAt ||
    playback.startedAt > Date.now()
  )
    return
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
