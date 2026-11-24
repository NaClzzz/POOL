import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { fromNodeHeaders } from 'better-auth/node'
import { z } from 'zod'
import { auth } from '../auth/core'
import { BusinessError } from '../http/errors'
import { readServerEnv } from '../env'
import { commandSchemas } from './validation'
import { RoomService, type RoomNotice, type RoomUser } from './service'
import type {
  ClientRoomEvents,
  ServerRoomEvents,
  RoomCommands,
  RoomAck,
  RoomCommandResult,
} from '@/contracts/room'

/** 入房与房主管理命令复查实时会话；聊天/轮播等高频命令复用建连会话与定时复查。 */
const SESSION_SENSITIVE_COMMANDS = new Set<keyof RoomCommands>([
  'room:join',
  'room:switch',
  'room:update-settings',
  'room:kick-member',
  'room:dissolve',
])

/** Socket 监听配置。 */
export function roomServerConfig() {
  return z
    .object({
      SOCKET_HOST: z.string().default('127.0.0.1'),
      SOCKET_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    })
    .parse(process.env)
}

/** 创建可测试的 Socket 服务，不在模块导入时监听端口。 */
export async function createRoomSocketServer(options: { sessionCheckIntervalMs?: number } = {}) {
  const env = readServerEnv()
  const config = roomServerConfig()
  const origin = new URL(env.BETTER_AUTH_URL).origin
  const sessionCheckIntervalMs = options.sessionCheckIntervalMs ?? 60_000
  const httpServer = createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: req.url === '/health' }))
  })
  const io = new Server<
    ClientRoomEvents,
    ServerRoomEvents,
    Record<string, never>,
    { user: RoomUser }
  >(httpServer, {
    cors: { origin, credentials: true },
    maxHttpBufferSize: 16_384,
    allowRequest: (req, done) => done(null, !req.headers.origin || req.headers.origin === origin),
  })

  /** 所有 io 广播和连接退出集中在 Socket 入口。 */
  const sendRoomNotice = (notice: RoomNotice) => {
    if (notice.type === 'state') io.to(`room:${notice.roomCode}`).emit('room:state', notice.state)
    else if (notice.type === 'chat')
      io.to(`room:${notice.roomCode}`).emit('room:message', notice.message)
    else if (notice.type === 'playlist')
      io.to(`user:${notice.userId}`).emit('user:room-playlist', notice.items)
    else
      for (const id of notice.socketIds) {
        const socket = io.sockets.sockets.get(id)
        if (socket) {
          void socket.leave(`room:${notice.roomCode}`)
          socket.emit('room:forced-leave', { roomCode: notice.roomCode, reason: notice.reason })
        }
      }
  }

  const service = new RoomService(sendRoomNotice)

  /** 建连握手校验 Better Auth 会话，拒绝未登录连接。 */
  io.use(async (socket, next) => {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(socket.request.headers),
        query: { disableRefresh: true },
      })
      if (!session) {
        next(Object.assign(new Error('请先登录'), { data: { code: 'UNAUTHENTICATED' } }))
        return
      }
      socket.data.user = { id: session.user.id, name: session.user.name, image: session.user.image }
      next()
    } catch {
      next(new Error('无法验证账号会话'))
    }
  })

  io.on('connection', (socket) => {
    void socket.join(`user:${socket.data.user.id}`)
    let closed = false
    let checking = false

    /** 复查 Better Auth 会话，失效时立即强制断开连接。 */
    const checkSession = async () => {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(socket.request.headers),
        query: { disableRefresh: true },
      })
      if (!session) {
        socket.emit('room:forced-leave', { roomCode: '', reason: 'session-expired' })
        socket.disconnect(true)
        throw new BusinessError('UNAUTHENTICATED', '账号会话已失效', 401)
      }
      const user: RoomUser = {
        id: session.user.id,
        name: session.user.name,
        image: session.user.image,
      }
      socket.data.user = user
      return user
    }

    const interval = setInterval(() => {
      if (checking) return
      checking = true
      void checkSession()
        .catch(() => socket.disconnect(true))
        .finally(() => {
          checking = false
        })
    }, sessionCheckIntervalMs)

    for (const command of Object.keys(commandSchemas) as (keyof RoomCommands)[]) {
      /** 动态注册共享事件参数类型；参数只在此入口进行 Zod 校验。 */
      const handle = async (
        payload: unknown,
        ack: (result: RoomAck<RoomCommandResult>) => void,
      ) => {
        if (typeof ack !== 'function') return
        const requestId = randomRequestId()
        try {
          const user = SESSION_SENSITIVE_COMMANDS.has(command)
            ? await checkSession()
            : socket.data.user
          const parsed = commandSchemas[command].parse(payload)
          if (closed) return
          const data = await service.execute(
            socket.id,
            user,
            command,
            parsed as RoomCommands[typeof command],
          )
          // disconnect 可能发生在数据库等待中，晚完成的 join 必须撤销。
          if (closed) {
            await service.disconnect(socket.id)
            return
          }
          if (data.snapshot) await socket.join(`room:${data.snapshot.room.roomCode}`)
          else
            for (const room of socket.rooms) if (room.startsWith('room:')) await socket.leave(room)
          ack({ ok: true, data, requestId })
        } catch (error) {
          if (error instanceof z.ZodError)
            ack({
              ok: false,
              error: { code: 'INVALID_INPUT', message: '请求参数格式不正确' },
              requestId,
            })
          else if (error instanceof BusinessError)
            ack({
              ok: false,
              error: { code: error.code, message: error.message },
              requestId,
              retryAfter: error.retryAfter,
            })
          else {
            console.error(
              `[rooms] 命令失败 ${requestId}`,
              error instanceof Error ? error.name : 'UnknownError',
            )
            ack({
              ok: false,
              error: { code: 'INTERNAL_ERROR', message: '房间服务暂时不可用' },
              requestId,
            })
          }
        }
      }
      socket.on(command, handle)
    }
    socket.on('disconnect', () => {
      closed = true
      clearInterval(interval)
      void service.disconnect(socket.id).catch(() => console.error('[rooms] 断开清理失败'))
    })
  })

  await service.start()

  return {
    httpServer,
    io,
    service,
    config,
    async close() {
      service.stop()
      await new Promise<void>((resolve) => io.close(() => resolve()))
      await service.drain()
    },
  }
}

/** 每条命令独立关联日志，不记录 Cookie 或载荷。 */
function randomRequestId() {
  return crypto.randomUUID()
}
