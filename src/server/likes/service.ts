import { and, asc, count, desc, eq } from 'drizzle-orm'
import type { Track, LikedTrack, MusicSource } from '@/contracts/domain'
import type { ImportLikesResult, Page } from '@/contracts/music'
import { trackKey } from '@/contracts/domain'
import { db } from '../db'
import { user } from '../db/schema'
import { likedSongs } from '../db/likes-schema'
import { BusinessError } from '../http/errors'
import { musicService } from '../music/service'
import { musicKey } from '../music/runtime'
import { getRedis } from '../redis'

/** 数据库行转换为安全收藏 DTO，不返回所有者 ID。 */
function likedDto(row: typeof likedSongs.$inferSelect): LikedTrack {
  const { source, source_id, title, author, album, duration_ms, cover_url, extra, addedAt } = row
  return {
    source,
    source_id,
    title,
    author,
    album,
    duration_ms,
    cover_url,
    extra,
    addedAt: addedAt.toISOString(),
  }
}

/** 所有收藏写操作锁定同一个用户行，使并发新增和导入共用 500 首容量。 */
async function insertTracks(userId: string, tracks: Track[], rejectOverflow: boolean) {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .for('update')
    if (!owner) throw new BusinessError('UNAUTHENTICATED', '登录已失效', 401)
    const existing = await tx.select().from(likedSongs).where(eq(likedSongs.userId, userId))
    const keys = new Set(existing.map(trackKey))
    const candidates: Track[] = []
    let duplicates = 0
    for (const track of tracks) {
      if (keys.has(trackKey(track))) duplicates++
      else {
        keys.add(trackKey(track))
        candidates.push(track)
      }
    }
    const available = Math.max(0, 500 - existing.length)
    if (rejectOverflow && candidates.length > available)
      throw new BusinessError('LIKES_LIMIT_REACHED', '喜欢列表已满，最多 500 首', 409)
    const accepted = candidates.slice(0, available)
    const now = Date.now()
    const inserted = accepted.length
      ? await tx
          .insert(likedSongs)
          .values(
            accepted.map((track, index) => ({ ...track, userId, addedAt: new Date(now - index) })),
          )
          .onConflictDoNothing()
          .returning()
      : []
    return {
      items: inserted.map(likedDto),
      duplicates,
      skipped: candidates.length - accepted.length,
      remaining: 500 - existing.length - inserted.length,
      existing,
    }
  })
}

/** 收藏查询、增删和导入的持久服务；不将外部网络调用放进数据库事务。 */
export const likesService = {
  async list(userId: string, offset: number, limit: number): Promise<Page<LikedTrack>> {
    const rows = await db
      .select()
      .from(likedSongs)
      .where(eq(likedSongs.userId, userId))
      .orderBy(desc(likedSongs.addedAt), asc(likedSongs.source), asc(likedSongs.source_id))
      .offset(offset)
      .limit(limit)
    const [size] = await db
      .select({ total: count() })
      .from(likedSongs)
      .where(eq(likedSongs.userId, userId))
    return {
      items: rows.map(likedDto),
      offset,
      limit,
      total: size.total,
      hasMore: offset + rows.length < size.total,
    }
  },
  async add(userId: string, track: Track) {
    const [duplicate] = await db
      .select()
      .from(likedSongs)
      .where(
        and(
          eq(likedSongs.userId, userId),
          eq(likedSongs.source, track.source),
          eq(likedSongs.source_id, track.source_id),
        ),
      )
    if (duplicate) return { item: likedDto(duplicate), added: false }
    const canonical = await musicService.getTrack(track.source, track.source_id, track.extra)
    const result = await insertTracks(userId, [canonical], true)
    const item =
      result.items[0] ??
      likedDto(result.existing.find((item) => trackKey(item) === trackKey(canonical))!)
    return { item, added: result.items.length === 1 }
  },
  async remove(userId: string, source: MusicSource, id: string) {
    await db.transaction(async (tx) => {
      await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update')
      await tx
        .delete(likedSongs)
        .where(
          and(
            eq(likedSongs.userId, userId),
            eq(likedSongs.source, source),
            eq(likedSongs.source_id, id),
          ),
        )
    })
    return null
  },
  // 清空收藏列表，返回 null 以避免误用
  async clear(userId: string) {
    await db.transaction(async (tx) => {
      // 加锁
      await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update')
      // 删除所有收藏
      await tx.delete(likedSongs).where(eq(likedSongs.userId, userId))
    })
    return null
  },

  async importPlaylist(userId: string, url: string): Promise<ImportLikesResult> {
    const redis = await getRedis().catch(() => {
      throw new BusinessError('LIMITER_UNAVAILABLE', '导入服务暂时不可用', 503)
    })
    const lock = musicKey(`import:${userId}`)
    const attempt = crypto.randomUUID()
    if (!(await redis.set(lock, attempt, { NX: true, EX: 120 })))
      throw new BusinessError('IMPORT_IN_PROGRESS', '已有歌单正在导入，请稍后重试', 409)
    try {
      const current = await likesService.list(userId, 0, 500)
      if (current.total === 500)
        throw new BusinessError('LIKES_LIMIT_REACHED', '喜欢列表已满，最多 500 首', 409)
      const remaining = 500 - current.items.length
      const seen = new Set(current.items.map(trackKey))
      const tracks: Track[] = []
      let offset = 0,
        newCount = 0,
        failed = 0,
        hasMore = true
      const deadline = Date.now() + 60000
      while (hasMore && newCount < remaining) {
        if (Date.now() > deadline)
          throw new BusinessError(
            'UPSTREAM_TIMEOUT',
            '歌单读取超时，请稍后重试；未写入本次导入',
            504,
          )
        const limit = 100
        const page = await musicService.getPlaylistTracks('netease', url, offset, limit)
        const requested = Math.min(
          limit,
          Math.max(0, (page.tracks.total ?? offset + limit) - offset),
        )
        failed += requested - page.tracks.items.length
        tracks.push(...page.tracks.items)
        for (const track of page.tracks.items)
          if (!seen.has(trackKey(track))) {
            seen.add(trackKey(track))
            newCount++
          }
        offset += limit
        hasMore = page.tracks.hasMore === true
      }
      const result = await insertTracks(userId, tracks, false)
      return {
        added: result.items.length,
        duplicates: result.duplicates,
        failed,
        capacitySkipped: hasMore ? null : result.skipped,
        remainingCapacity: result.remaining,
        hasMore,
      }
    } finally {
      await redis
        .eval(
          "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
          { keys: [lock], arguments: [attempt] },
        )
        .catch(() => {
          /* 租约到期自动释放，不覆盖已完成结果。 */
        })
    }
  },
}
