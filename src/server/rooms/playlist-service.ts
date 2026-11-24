import { randomUUID } from 'node:crypto'
import { trackKey, type Track } from '@/contracts/domain'
import type { RoomImportResult, RoomPlaylistItem } from '@/contracts/room'
import { businessRequest } from '../http/business'
import { BusinessError } from '../http/errors'
import { musicService } from '../music/service'
import { referenceSchema } from '../music/validation'
import { playlistItemIdSchema, playlistReorderSchema } from './validation'
import * as repo from './repository'

/** 个人房间歌单容量上限。 */
const PLAYLIST_LIMIT = 500

/** 校验曲目是否满足房间轮播准入要求（当前仅支持有效时长的网易云曲目）。 */
function isPlayableRoomTrack(track: Track) {
  return track.source === 'netease' && !!track.duration_ms && track.duration_ms > 0
}

/** 用户私有房间歌单服务，直接在 Web 进程内调用统一音乐服务与数据库事务。 */
export const roomPlaylistService = {
  /** 读取当前用户的持久房间歌单。 */
  list(userId: string): Promise<RoomPlaylistItem[]> {
    return repo.getPlaylist(userId)
  },

  /** 按曲目引用取得服务端权威资料并置顶写入，容量上限 500 首。 */
  async add(
    userId: string,
    reference: { source: Track['source']; source_id: string; extra?: Track['extra'] },
  ): Promise<RoomPlaylistItem[]> {
    const track = await musicService.getTrack(
      reference.source,
      reference.source_id,
      reference.extra ?? null,
    )
    if (!isPlayableRoomTrack(track))
      throw new BusinessError(
        'TRACK_DURATION_REQUIRED',
        '该歌曲缺少有效时长，不能加入房间歌单',
        409,
      )
    await repo.editPlaylist(userId, (items) => {
      if (items.some((i) => trackKey(i.track) === trackKey(track)))
        throw new BusinessError('TRACK_ALREADY_ADDED', '歌曲已在房间歌单中', 409)
      if (items.length >= PLAYLIST_LIMIT)
        throw new BusinessError('PLAYLIST_LIMIT_REACHED', '房间歌单最多 500 首', 409)
      return [{ itemId: randomUUID(), position: 0, track }, ...items]
    })
    return repo.getPlaylist(userId)
  },

  /** 按服务端 itemId 移除条目。 */
  async remove(userId: string, itemId: string): Promise<RoomPlaylistItem[]> {
    await repo.editPlaylist(userId, (items) => {
      const index = items.findIndex((i) => i.itemId === itemId)
      if (index < 0) throw new BusinessError('ITEM_NOT_FOUND', '歌单条目不存在', 404)
      items.splice(index, 1)
      return items
    })
    return repo.getPlaylist(userId)
  },

  /** 将指定条目移动到目标索引。 */
  async reorder(userId: string, itemId: string, toIndex: number): Promise<RoomPlaylistItem[]> {
    await repo.editPlaylist(userId, (items) => {
      const index = items.findIndex((i) => i.itemId === itemId)
      if (index < 0) throw new BusinessError('ITEM_NOT_FOUND', '歌单条目不存在', 404)
      const [item] = items.splice(index, 1)
      if (toIndex > items.length) throw new BusinessError('INVALID_INPUT', '排序位置无效', 400)
      items.splice(toIndex, 0, item)
      return items
    })
    return repo.getPlaylist(userId)
  },

  /** 随机打乱当前用户的房间歌单。 */
  async shuffle(userId: string): Promise<RoomPlaylistItem[]> {
    await repo.editPlaylist(userId, (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[items[i], items[j]] = [items[j], items[i]]
      }
      return items
    })
    return repo.getPlaylist(userId)
  },

  /** 清空当前用户的房间歌单，不影响正在播放的节目。 */
  async clear(userId: string): Promise<RoomPlaylistItem[]> {
    await repo.editPlaylist(userId, () => [])
    return []
  },

  /** 将服务端喜欢列表中的有效歌曲导入房间歌单，按原顺序填满剩余容量。 */
  async importLiked(userId: string): Promise<RoomImportResult> {
    const likes = await repo.likedTracks(userId)
    const stats = { added: 0, duplicates: 0, failed: 0, capacitySkipped: 0 }
    await repo.editPlaylist(userId, (items) => {
      const seen = new Set(items.map((i) => trackKey(i.track)))
      for (const liked of likes) {
        if (seen.has(trackKey(liked))) {
          stats.duplicates++
          continue
        }
        if (!isPlayableRoomTrack(liked)) {
          stats.failed++
          continue
        }
        if (items.length >= PLAYLIST_LIMIT) {
          stats.capacitySkipped++
          continue
        }
        const { source, source_id, title, author, album, duration_ms, cover_url, extra } = liked
        items.push({
          itemId: randomUUID(),
          position: items.length,
          track: { source, source_id, title, author, album, duration_ms, cover_url, extra },
        })
        seen.add(trackKey(liked))
        stats.added++
      }
      return items
    })
    return { items: await repo.getPlaylist(userId), ...stats }
  },
}

/** 房间歌单主入口：支持查询、新增、排序和删除。 */
export function roomPlaylistRequest(request: Request) {
  return businessRequest(request, async (userId) => {
    if (request.method === 'GET') return { data: await roomPlaylistService.list(userId) }
    if (request.method === 'DELETE') {
      const { itemId } = playlistItemIdSchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      )
      return { data: await roomPlaylistService.remove(userId, itemId) }
    }
    if (request.method === 'PATCH') {
      const { itemId, toIndex } = playlistReorderSchema.parse(await request.json())
      return { data: await roomPlaylistService.reorder(userId, itemId, toIndex) }
    }
    const reference = referenceSchema.parse(await request.json())
    return { data: await roomPlaylistService.add(userId, reference), status: 201 }
  })
}

/** 打乱房间歌单。 */
export function shuffleRoomPlaylistHandler(request: Request) {
  return businessRequest(request, async (userId) => ({
    data: await roomPlaylistService.shuffle(userId),
  }))
}

/** 清空房间歌单。 */
export function clearRoomPlaylistHandler(request: Request) {
  return businessRequest(request, async (userId) => ({
    data: await roomPlaylistService.clear(userId),
  }))
}

/** 从服务端喜欢列表导入房间歌单。 */
export function importRoomPlaylistLikedHandler(request: Request) {
  return businessRequest(request, async (userId) => ({
    data: await roomPlaylistService.importLiked(userId),
  }))
}
