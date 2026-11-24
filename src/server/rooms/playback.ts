import { BusinessError } from '../http/errors'
import type { Playback, RoomCommands } from '@/contracts/room'
import * as repo from './repository'

/** 可信身份只从 Better Auth 会话取得。 */
export type RoomUser = { id: string; name: string; image?: string | null }
/** 同一用户多标签页合并为一个在线成员。 */
export type OnlineMember = { user: RoomUser; joinedAt: Date; sockets: Set<string> }
/** 单实例房间权威状态；不把连接与定时器持久化。 */
export type LiveRoom = {
  row: repo.RoomRow
  members: Map<string, OnlineMember>
  stage: string[]
  playback: Playback
  activeIndex: number
  timer?: ReturnType<typeof setTimeout>
  startTimer?: ReturnType<typeof setTimeout>
}

/** 播放引擎回调依赖，由 RoomService 注入串行调度与广播。 */
export type PlaybackDeps = {
  runRoomSerial: (roomCode: string, action: () => Promise<void>) => Promise<void>
  broadcast: (live: LiveRoom) => Promise<void>
  playlistChanged: (userId: string) => Promise<void>
}

/** 空闲状态仍推进版本，使迟到的旧媒体报告失效。 */
export function idlePlayback(roomId: string, roomCode: string, version: number): Playback {
  return {
    roomId,
    roomCode,
    version,
    status: 'idle',
    track: null,
    activeMemberId: null,
    currentItemId: null,
    startedAt: null,
    startOffsetMs: 0,
    durationMs: null,
    votes: [],
    skipVoteRequired: 0,
  }
}

/** 以现有在线成员重新计算票数，离线用户的票不继续占位。 */
export function updateVotes(live: LiveRoom) {
  const eligible = [...live.members.keys()].filter((id) => id !== live.playback.activeMemberId)
  live.playback.votes = live.playback.votes.filter((id) => eligible.includes(id))
  live.playback.skipVoteRequired = live.playback.track ? eligible.length : 0
}

/** 只持久化已经到达起播锚点的有效节目，不记录预加载。 */
export async function recordPlayed(playback: Playback) {
  if (
    !playback.track ||
    !playback.activeMemberId ||
    !playback.startedAt ||
    playback.startedAt > Date.now()
  )
    return
  await repo.recordPlayed(playback)
}

/** 自然结束、切歌和错误都走同一推进路径，一次最多扫描一轮上台成员。 */
export async function advancePlayback(live: LiveRoom, deps: PlaybackDeps, from = live.activeIndex) {
  clearTimeout(live.timer)
  clearTimeout(live.startTimer)
  await recordPlayed(live.playback)
  let next = idlePlayback(live.row.id, live.row.code, live.playback.version + 1)
  let activeIndex = -1
  for (let step = 1; step <= live.stage.length; step++) {
    const index = (from + step + live.stage.length) % live.stage.length
    const userId = live.stage[index]
    const items = await repo.getPlaylist(userId)
    const item = items.find(
      (i) => i.track.source === 'netease' && !!i.track.duration_ms && i.track.duration_ms > 0,
    )
    if (!item) continue
    await repo.editPlaylist(userId, (current) => {
      const at = current.findIndex((i) => i.itemId === item.itemId)
      const [head] = current.splice(at, 1)
      current.push(head)
      return current
    })
    next = {
      ...next,
      status: 'playing',
      track: item.track,
      activeMemberId: userId,
      currentItemId: item.itemId,
      startedAt: Date.now() + 4000,
      durationMs: item.track.duration_ms,
    }
    activeIndex = index
    await deps.playlistChanged(userId)
    break
  }
  await repo.savePlayback(next, activeIndex)
  live.playback = next
  live.activeIndex = activeIndex
  updateVotes(live)
  if (next.status === 'playing') {
    const version = next.version
    live.startTimer = setTimeout(
      () =>
        void deps
          .runRoomSerial(live.row.code, async () => {
            if (live.playback.version === version) await recordPlayed(next)
          })
          .catch(() => console.error('[rooms] 播放记录写入失败')),
      Math.max(0, next.startedAt! - Date.now()),
    )
    live.timer = setTimeout(
      () =>
        void deps
          .runRoomSerial(live.row.code, async () => {
            if (live.playback.version !== version) return
            await advancePlayback(live, deps)
            await deps.broadcast(live)
          })
          .catch(() => console.error('[rooms] 轮播推进失败')),
      Math.max(0, next.startedAt! + next.durationMs! - Date.now()),
    )
  }
}

/** 上台后仅在等待状态启动轮播，不打断当前节目。 */
export async function joinStage(live: LiveRoom, userId: string, deps: PlaybackDeps) {
  if (live.stage.includes(userId)) return
  if (live.stage.length >= live.row.maxStageMembers)
    throw new BusinessError('STAGE_FULL', '上台人数已满', 409)
  live.stage.push(userId)
  if (live.playback.status === 'idle') await advancePlayback(live, deps)
}

/** 下台调整游标，当前播放者下台后立即轮到其后继。 */
export async function removeStage(live: LiveRoom, userId: string, deps: PlaybackDeps) {
  const index = live.stage.indexOf(userId)
  if (index < 0) return
  const current = live.playback.activeMemberId === userId
  live.stage.splice(index, 1)
  if (index <= live.activeIndex) live.activeIndex--
  if (current) await advancePlayback(live, deps)
}

/** 非播放者每人计一票，达到实时人数门槛后推进节目。 */
export async function voteSkip(live: LiveRoom, userId: string, deps: PlaybackDeps) {
  if (!live.playback.track || live.playback.activeMemberId === userId)
    throw new BusinessError('FORBIDDEN', '当前不能投票', 403)
  if (!live.playback.votes.includes(userId)) live.playback.votes.push(userId)
  updateVotes(live)
  if (live.playback.votes.length >= live.playback.skipVoteRequired)
    await advancePlayback(live, deps)
}

/** 仅当前播放者对当前版本和条目的失败报告能推进房间。 */
export async function reportMediaError(
  live: LiveRoom,
  userId: string,
  report: RoomCommands['room:playback:media-error'],
  deps: PlaybackDeps,
) {
  if (
    live.playback.activeMemberId === userId &&
    live.playback.version === report.version &&
    live.playback.currentItemId === report.itemId
  )
    await advancePlayback(live, deps)
}
