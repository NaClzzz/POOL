import { randomBytes, randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { BusinessError } from '../http/errors'
import type { CreateRoom, RoomHistory, RoomHistoryDetail } from '@/contracts/room'
import * as repo from './repository'

/** 空房与归档的业务保留期限。 */
export const EMPTY_ROOM_MS = 30 * 60_000
export const ARCHIVE_MS = 7 * 24 * 60 * 60_000
/** 每人保留最近五十条成功加入凭证。 */
export const ROOM_HISTORY_LIMIT = 50

/** 房间活动状态只在业务层判定，Repository 负责按条件读写。 */
export function isActiveRoom(row: repo.RoomRow, now = Date.now()) {
  return row.status === 'active' && (row.memberCount > 0 || row.emptyExpiresAt.getTime() > now)
}

/** 创建时在用户事务锁内判断已有有效房间，密码原文不进入 Repository。 */
export async function createRoom(userId: string, input: CreateRoom) {
  const passwordHash = input.password ? await hashPassword(input.password) : null
  const row = await repo.createRoom(
    {
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
    },
    (owned) => {
      if (owned.some((room) => isActiveRoom(room)))
        throw new BusinessError('ROOM_ALREADY_CREATED', '你已有有效房间，请进入我的房间', 409)
    },
  )
  return repo.safeRoom(row)
}

/** 大厅只读取有效活动房间，分页和公开房筛选由 Repository 转成查询。 */
export function listRooms(userId: string, q: string, offset: number, limit: number) {
  return repo.listRooms(userId, q, offset, limit, {
    status: 'active',
    minMemberCount: 1,
    emptyExpiresAfter: new Date(),
    publicOnly: true,
  })
}

/** 成功加入后在同一用户事务内应用历史淘汰规则。 */
export function recordRoomJoin(row: repo.RoomRow, userId: string, count: number, joinedAt: Date) {
  return repo.recordJoin(row, userId, count, joinedAt, (ids) => ids.slice(ROOM_HISTORY_LIMIT))
}

/** 有效历史不依赖当前房主或在线成员身份。 */
export async function listHistory(userId: string): Promise<RoomHistory[]> {
  const rows = await repo.listHistory(userId)
  const now = Date.now()
  return rows
    .filter(({ room }) => !room.expiresAt || room.expiresAt.getTime() > now)
    .map(({ room, name, joined }) => ({
      ...repo.roomDto(room, name),
      lastJoinedAt: joined.toISOString(),
    }))
}

/** 删除只撤销本人凭证，与新增历史复用 Repository 的用户事务锁。 */
export function deleteHistory(userId: string, roomId: string) {
  return repo.deleteHistory(userId, roomId)
}

/** 详情要求本人仍持有有效凭证，权限错误在业务层产生。 */
export async function historyDetail(userId: string, roomId: string): Promise<RoomHistoryDetail> {
  const row = (await listHistory(userId)).find((item) => item.roomId === roomId)
  if (!row) throw new BusinessError('ROOM_HISTORY_REQUIRED', '房间已到期或没有访问记录', 403)
  return { ...row, ...(await repo.historyActivity(roomId)) }
}
