import { z } from 'zod'
import {
  catalog,
  createSeed,
  DEMO_ROOM_PASSWORD,
  makeTracks,
  analysisText,
  summaryText,
} from './fixtures'
import {
  trackKey,
  type ApiResult,
  type DemoDatabase,
  type DemoScenario,
  type Room,
  type Track,
} from '@/contracts/domain'
import type { AccountUser } from '@/contracts/auth'

const DATABASE_KEY = 'pool:prototype:v1:data'
let database: DemoDatabase | null = null
let session: AccountUser | null = null
let requestNumber = 0
let generatingCount = 0
const running = new Set<string>()

/** 让业务 hooks 以统一错误码呈现 mock 接口失败。 */
export class ApiError extends Error {
  readonly response: ApiResult<never>
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message)
    this.name = 'ApiError'
    this.response = { ok: false, error: { code, message }, requestId: `mock-${++requestNumber}` }
  }
}

/** 延迟模拟可取消接口，不创建真实网络请求。 */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'))
      return
    }
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('已取消', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** 只在模拟服务入口加载独立命名空间下的业务数据。 */
export function getDatabase(): DemoDatabase {
  if (!database) {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(DATABASE_KEY) : null
    database = saved ? (JSON.parse(saved) as DemoDatabase) : createSeed()
    database.messages ??= {}
    database.playedSongs ??= {}
    for (const summary of Object.values(database.summaries))
      if (summary.status === 'generating') {
        summary.status = 'failed'
        summary.attemptId = null
      }
  }
  return database
}

/** 将模拟业务资料写回本地，实时房间状态不写入。 */
export function saveDatabase() {
  if (typeof window !== 'undefined')
    window.localStorage.setItem(DATABASE_KEY, JSON.stringify(getDatabase()))
}

/** 仅桥接真实会话的安全资料给尚未接后端的 mock 业务，不持久化认证身份。 */
export function setMockUser(user: AccountUser | null) {
  session = user
}

/** mock 用户级操作读取当前桥接身份；这不是服务端鉴权入口。 */
export function requireUser(): AccountUser {
  if (!session) throw new ApiError('UNAUTHENTICATED', '请先登录', 401)
  return session
}

/** 执行统一异步请求并解包标准成功响应，后续可替换成 HTTP transport。 */
async function request<T>(operation: () => T, signal?: AbortSignal): Promise<T> {
  const userId = session?.id
  const scenario = getDatabase().scenario
  await wait(process.env.NODE_ENV === 'test' ? 0 : scenario === 'slow' ? 1500 : 240, signal)
  if (userId !== session?.id) throw new DOMException('账号已切换', 'AbortError')
  if (scenario === 'offline')
    throw new ApiError('UPSTREAM_UNAVAILABLE', '暂时无法连接音乐服务，请稍后重试', 502)
  if (scenario === 'limited')
    throw new ApiError('RATE_LIMITED', '请求过于频繁，请在 10 秒后重试', 429)
  const response: ApiResult<T> = {
    ok: true,
    data: operation(),
    requestId: `mock-${++requestNumber}`,
  }
  return response.data
}

/** 尚未接入真实接口的业务服务；账号认证由 Better Auth 独立负责。 */
export const api = {
  /** 获取按关键词和音源筛选的统一曲目。 */
  search(source: string, q = '', signal?: AbortSignal) {
    return request(() => {
      requireUser()
      const keyword = q.trim().toLowerCase()
      return catalog.filter(
        (t) =>
          t.source === source &&
          `${t.title} ${t.author} ${t.album}`.toLowerCase().includes(keyword),
      )
    }, signal)
  },
  /** 取完整喜欢列表，以保证搜索结果喜欢状态不依赖已加载的分页。 */
  likes() {
    return request(() => [...(getDatabase().likes[requireUser().id] ?? [])])
  },
  /** 收藏去重与容量检查在同一个同步修改内完成。 */
  addLike(track: Track) {
    return request(() => {
      const db = getDatabase()
      const id = requireUser().id
      const items = db.likes[id] ?? []
      if (items.some((t) => trackKey(t) === trackKey(track))) return { added: false }
      if (items.length >= 500)
        throw new ApiError('LIKES_LIMIT_REACHED', '喜欢列表已满，最多收藏 500 首', 409)
      db.likes[id] = [{ ...track, addedAt: new Date().toISOString() }, ...items]
      saveDatabase()
      return { added: true }
    })
  },
  /** 幂等取消收藏。 */
  removeLike(track: Track) {
    return request(() => {
      const db = getDatabase()
      const id = requireUser().id
      db.likes[id] = (db.likes[id] ?? []).filter((t) => trackKey(t) !== trackKey(track))
      saveDatabase()
      return null
    })
  },
  /** 使用已知歌单样本模拟按顺序去重、填满剩余容量的导入。 */
  importLikes(url: string) {
    if (
      !/^https?:\/\/(?:music\.163\.com|y\.music\.163\.com)\//.test(url) ||
      !/playlist|list/.test(url)
    )
      return Promise.reject(new ApiError('INVALID_PLAYLIST_LINK', '请输入网易云歌单分享链接'))
    return request(() => {
      const db = getDatabase()
      const user = requireUser()
      const items = db.likes[user.id] ?? []
      const seed = makeTracks(36).filter((t) => t.source === 'netease')
      const seen = new Set(items.map(trackKey))
      let added = 0
      let duplicates = 0
      let capacitySkipped = 0
      for (const track of seed) {
        if (seen.has(trackKey(track))) {
          duplicates++
          continue
        }
        if (items.length >= 500) {
          capacitySkipped++
          continue
        }
        items.push({ ...track, addedAt: new Date().toISOString() })
        seen.add(trackKey(track))
        added++
      }
      db.likes[user.id] = items.sort((a, b) => b.addedAt.localeCompare(a.addedAt))
      saveDatabase()
      return {
        added,
        duplicates,
        failed: 0,
        capacitySkipped,
        remainingCapacity: 500 - items.length,
      }
    })
  },
  /** 返回大厅安全摘要与可搜索的密码房，不返回实时连接。 */
  rooms(q = '') {
    return request(() => {
      requireUser()
      return getDatabase().rooms.filter(
        (r) => r.status === 'active' && `${r.name} ${r.tag} ${r.roomCode}`.includes(q.trim()),
      )
    })
  },
  /** 创建一个演示房间；密码只标记为标准演示密码，不持久保存用户输入。 */
  createRoom(input: {
    name: string
    tag: string
    maxMembers: number
    maxStageMembers: number
    protected: boolean
  }) {
    const parsed = z
      .object({
        name: z.string().trim().min(2).max(20),
        tag: z.string().trim().min(2).max(12),
        maxMembers: z.number().int().min(2).max(50),
        maxStageMembers: z.number().int().min(1).max(30),
        protected: z.boolean(),
      })
      .safeParse(input)
    if (!parsed.success || input.maxStageMembers > input.maxMembers)
      return Promise.reject(new ApiError('INVALID_INPUT', '请检查名称、标签与人数设置'))
    return request(() => {
      const db = getDatabase()
      const user = requireUser()
      if (db.rooms.some((r) => r.createdBy === user.id && r.status === 'active'))
        throw new ApiError('ROOM_EXISTS', '你已有一个有效房间，请进入我的房间', 409)
      const id = `room-${Date.now()}`
      const room: Room = {
        roomId: id,
        roomCode: `pool-${id.slice(-6)}`,
        ...parsed.data,
        ownerId: user.id,
        ownerName: user.name,
        createdBy: user.id,
        memberCount: 0,
        cover: 'field',
        isPasswordProtected: input.protected,
        status: 'active',
        endedAt: null,
        expiresAt: null,
      }
      db.rooms.push(room)
      saveDatabase()
      return room
    })
  },
  /** 校验房间加入、密码及历史容量，连接本身留在房间模拟会话中。 */
  joinRoom(code: string, password = '') {
    return request(() => {
      const db = getDatabase()
      const user = requireUser()
      const room = db.rooms.find((r) => r.roomCode === code && r.status === 'active')
      if (!room) throw new ApiError('ROOM_NOT_FOUND', '房间不存在或已结束', 404)
      if (room.isPasswordProtected && password !== DEMO_ROOM_PASSWORD && room.ownerId !== user.id)
        throw new ApiError('ROOM_PASSWORD_REQUIRED', '请输入正确的房间密码', 403)
      if (room.memberCount >= room.maxMembers) throw new ApiError('ROOM_FULL', '房间人数已满', 409)
      const histories = db.history[user.id] ?? []
      db.history[user.id] = [
        { roomId: room.roomId, lastJoinedAt: new Date().toISOString() },
        ...histories.filter((h) => h.roomId !== room.roomId),
      ].slice(0, 50)
      saveDatabase()
      return { ...room }
    })
  },
  /** 获取有凭证且未过期的房间归档。 */
  history() {
    return request(() => {
      const db = getDatabase()
      const user = requireUser()
      return (db.history[user.id] ?? []).flatMap((h) => {
        const room = db.rooms.find((r) => r.roomId === h.roomId)
        return room && (!room.expiresAt || Date.parse(room.expiresAt) > Date.now())
          ? [
              {
                ...room,
                lastJoinedAt: h.lastJoinedAt,
                summary: db.summaries[h.roomId]?.status ?? 'notGenerated',
              },
            ]
          : []
      })
    })
  },
  /** 删除当前用户的历史凭证，不删除共享总结。 */
  deleteHistory(roomId: string) {
    return request(() => {
      const db = getDatabase()
      const id = requireUser().id
      db.history[id] = (db.history[id] ?? []).filter((h) => h.roomId !== roomId)
      saveDatabase()
      return null
    })
  },
  /** 读取归档前校验凭证与七天有效期。 */
  summary(roomId: string) {
    return request(() => {
      const db = getDatabase()
      const id = requireUser().id
      const room = db.rooms.find((r) => r.roomId === roomId)
      if (!room) throw new ApiError('ROOM_NOT_FOUND', '房间不存在', 404)
      if (!(db.history[id] ?? []).some((h) => h.roomId === roomId))
        throw new ApiError('ROOM_HISTORY_REQUIRED', '你已没有此房间的历史凭证', 403)
      if (room.expiresAt && Date.parse(room.expiresAt) <= Date.now())
        throw new ApiError('ROOM_EXPIRED', '这份房间记忆已超过 7 天', 410)
      return {
        room: { ...room },
        summary: db.summaries[roomId] ?? {
          status: 'notGenerated' as const,
          content: '',
          attemptId: null,
        },
      }
    })
  },
}

/** 读取用户的独立房间歌单；页面不直接操作数据库。 */
export function getRoomPlaylist(userId: string) {
  return [...(getDatabase().playlists[userId] ?? catalog.slice(0, 3))]
}
/** 将房间歌单修改保存到模拟业务库。 */
export function saveRoomPlaylist(userId: string, tracks: Track[]) {
  getDatabase().playlists[userId] = [...tracks]
  saveDatabase()
}
/** 保留房间消息业务记录，客户端近期消息只是此数据的投影。 */
export function appendRoomMessage(
  roomId: string,
  message: import('@/contracts/domain').ChatMessage,
) {
  const db = getDatabase()
  const messages = db.messages[roomId] ?? []
  messages.push(message)
  db.messages[roomId] = messages.slice(-10_000)
  saveDatabase()
}
/** 记录实际起播的节目，按最近 500 条约束总结资料。 */
export function recordRoomPlayback(roomId: string, track: Track) {
  const db = getDatabase()
  db.playedSongs[roomId] = [...(db.playedSongs[roomId] ?? []), track].slice(-500)
  saveDatabase()
}
/** 结束活动房间并生成七天有效的归档。 */
export function endRoom(roomId: string) {
  const room = getDatabase().rooms.find((r) => r.roomId === roomId)
  if (!room) return
  room.status = 'ended'
  room.memberCount = 0
  room.endedAt = new Date().toISOString()
  room.expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString()
  saveDatabase()
}
/** 保存活动房间设置，房主管理权限由模拟会话校验。 */
export function updateRoom(room: Room) {
  const db = getDatabase()
  db.rooms = db.rooms.map((r) => (r.roomId === room.roomId ? { ...room } : r))
  saveDatabase()
}
/** 切换明确的演示场景，不随机制造错误。 */
export function setScenario(value: DemoScenario) {
  getDatabase().scenario = value
  saveDatabase()
}
/** 准备接近容量上限的收藏列表以验证长列表和导入行为。 */
export function fillLikes() {
  const db = getDatabase()
  const id = requireUser().id
  db.likes[id] = [...catalog.slice(0, 10), ...makeTracks(600).slice(90, 578)].map((t) => ({
    ...t,
    addedAt: new Date().toISOString(),
  }))
  saveDatabase()
}
/** 重置所有演示业务资料，保留当前真实账号的界面身份以便重复演示。 */
export function resetDemo() {
  database = createSeed()
  generatingCount = 0
  running.clear()
  saveDatabase()
}

/** 以固定文本分段生成分析或总结，模拟取消、失败、名额及成功后锁定。 */
export async function generateText(
  kind: 'analysis' | 'summary',
  roomId: string | undefined,
  onText: (text: string) => void,
  signal: AbortSignal,
) {
  const user = requireUser()
  const key = kind === 'analysis' ? `analysis:${user.id}` : `summary:${roomId}`
  if (running.has(key))
    throw new ApiError('SUMMARY_GENERATING', '正在生成，请等待当前请求完成', 409)
  if (generatingCount >= 10) throw new ApiError('AI_BUSY', '当前生成名额已满，请稍后重试', 503)
  if (kind === 'analysis' && !getDatabase().likes[user.id]?.length)
    throw new ApiError('EMPTY_PLAYLIST', '请先添加喜欢的歌曲')
  running.add(key)
  generatingCount++
  let completed = false
  let summaryStarted = false
  try {
    if (kind === 'summary') {
      const existing = await api.summary(roomId!)
      if (existing.room.status !== 'ended')
        throw new ApiError('ROOM_NOT_ENDED', '房间结束后才能生成总结', 409)
      if (existing.summary.status === 'succeeded') {
        onText(existing.summary.content)
        completed = true
        return
      }
      getDatabase().summaries[roomId!] = {
        status: 'generating',
        content: '',
        attemptId: `attempt-${Date.now()}`,
      }
      saveDatabase()
      summaryStarted = true
    }
    await wait(process.env.NODE_ENV === 'test' ? 0 : 550, signal)
    if (getDatabase().scenario === 'ai-fail')
      throw new ApiError('AI_UNAVAILABLE', '生成暂时失败，请稍后手动重试', 502)
    if (getDatabase().scenario === 'offline' || getDatabase().scenario === 'limited')
      throw new ApiError('AI_UNAVAILABLE', '服务暂不可用，请稍后重试', 503)
    const text = kind === 'analysis' ? analysisText : summaryText
    for (let i = 0; i < text.length; i += 8) {
      await wait(process.env.NODE_ENV === 'test' ? 0 : 45, signal)
      onText(text.slice(0, i + 8))
    }
    if (kind === 'summary') {
      const existing = await api.summary(roomId!)
      getDatabase().summaries[existing.room.roomId] = {
        status: 'succeeded',
        content: text,
        attemptId: null,
      }
      saveDatabase()
    }
    completed = true
  } finally {
    running.delete(key)
    generatingCount--
    if (!completed && summaryStarted) {
      getDatabase().summaries[roomId!] = { status: 'failed', content: '', attemptId: null }
      saveDatabase()
    }
  }
}
