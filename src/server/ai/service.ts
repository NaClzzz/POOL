import { randomUUID } from 'node:crypto'
import type { RoomSummaryDto } from '@/contracts/ai'
import { BusinessError } from '../http/errors'
import { likesService } from '../likes/service'
import { musicService } from '../music/service'
import { accessSummary, summaryInput, type SummaryAccess, type SummaryRow } from './repository'
import { sampleLyrics, playlistPrompt, summaryPrompt } from './prompts'

/** 资格最长保留两分钟，进程意外结束后可由查询或下次生成恢复。 */
const ATTEMPT_MS = 120_000

/** 访问资格只依赖有效历史记录；活动房间不能提前生成总结。 */
function assertSummaryAccess(access: SummaryAccess) {
  if (!access.hasHistory || !access.room)
    throw new BusinessError('ROOM_HISTORY_REQUIRED', '你已没有该房间的历史访问权限', 403)
  if (access.room.expiresAt && access.room.expiresAt.getTime() <= Date.now())
    throw new BusinessError('ROOM_EXPIRED', '房间记录已过期', 410)
  if (access.room.status !== 'ended' || !access.room.expiresAt)
    throw new BusinessError('ROOM_NOT_ENDED', '房间结束后才能生成总结', 409)
  return access.room.expiresAt
}

/** 过期尝试标记失败；原尝试回写时会因状态或 attemptId 不符而被拒绝。 */
function recoverSummary(summary: SummaryRow | undefined) {
  return summary?.status === 'generating' && Date.now() - summary.startedAt.getTime() >= ATTEMPT_MS
    ? { ...summary, status: 'failed' as const, content: null, errorCode: 'AI_TIMEOUT' }
    : summary
}

/** 对外只投影正文与安全状态，不暴露触发用户和内部尝试标识。 */
function summaryDto(roomId: string, expiresAt: Date, row?: SummaryRow): RoomSummaryDto {
  return {
    roomId,
    status: row?.status ?? 'idle',
    content: row?.content ?? null,
    errorCode: row?.errorCode ?? null,
    generatedAt: row?.generatedAt?.toISOString() ?? null,
    expiresAt: expiresAt.toISOString(),
  }
}

/** 查询同一份共享状态，同时恢复超期生成资格。 */
export function getRoomSummary(userId: string, roomId: string) {
  return accessSummary(userId, roomId, (access) => {
    const expiry = assertSummaryAccess(access)
    const row = recoverSummary(access.summary)
    return {
      value: summaryDto(roomId, expiry, row),
      write: row !== access.summary ? row : undefined,
    }
  })
}

/** 在数据库锁内认领一次尝试；已有成功结果直接返回且不会触发模型。 */
export function claimRoomSummary(userId: string, roomId: string) {
  return accessSummary<{ summary: RoomSummaryDto; attemptId: string | null }>(
    userId,
    roomId,
    (access) => {
      const expiry = assertSummaryAccess(access)
      const row = recoverSummary(access.summary)
      if (row?.status === 'succeeded')
        return { value: { summary: summaryDto(roomId, expiry, row), attemptId: null } }
      if (row?.status === 'generating')
        throw new BusinessError('AI_IN_PROGRESS', '房间总结正在生成，请稍后查看', 409)
      const attempt: SummaryRow = {
        roomId,
        status: 'generating',
        attemptId: randomUUID(),
        requestedBy: userId,
        startedAt: new Date(),
        content: null,
        generatedAt: null,
        errorCode: null,
      }
      return {
        value: { summary: summaryDto(roomId, expiry, attempt), attemptId: attempt.attemptId },
        write: attempt,
      }
    },
  )
}

/** 从本人真实收藏读取输入，歌词调用统一音乐服务，不扣逐首用户查询额度。 */
export async function preparePlaylist(userId: string, signal: AbortSignal) {
  const tracks = (await likesService.list(userId, 0, 500)).items.filter((t) => t.title?.trim())
  if (!tracks.length) throw new BusinessError('AI_INPUT_EMPTY', '喜欢列表没有可分析的歌曲', 400)
  const lyrics = await sampleLyrics(
    tracks,
    (t) => musicService.getLyrics(t.source, t.source_id, t.extra),
    signal,
    1000,
  )
  return playlistPrompt(tracks, lyrics)
}

/** 最近播放与完整聊天只在服务端进入模型，歌词不按字符截取。 */
export async function prepareSummary(roomId: string, signal: AbortSignal) {
  const { tracks, messages } = await summaryInput(roomId)
  if (!tracks.some((t) => t.title?.trim()) && !messages.length)
    throw new BusinessError('AI_INPUT_EMPTY', '该房间没有可总结的歌曲或聊天记录', 400)
  const lyrics = await sampleLyrics(
    tracks,
    (t) => musicService.getLyrics(t.source, t.source_id, t.extra),
    signal,
  )
  return summaryPrompt(tracks, messages, lyrics)
}
