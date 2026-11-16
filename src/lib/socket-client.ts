import { io, type Socket } from 'socket.io-client'
import type {
  ClientRoomEvents,
  ServerRoomEvents,
  RoomCommands,
  RoomCommandResult,
  RoomAck,
} from '@/contracts/room'

/** Socket 命令错误仅包含业务码和等待秒数，不伪造 HTTP 状态。 */
export class RoomCommandError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryAfter: number | null = null,
  ) {
    super(message)
    this.name = 'RoomCommandError'
  }
}

/** 每次房间页挂载独享一个 Socket；部署默认使用同域代理。 */
export function createRoomSocket(): Socket<ServerRoomEvents, ClientRoomEvents> {
  const url = process.env.NEXT_PUBLIC_SOCKET_URL
  return io(url || undefined, {
    path: '/socket.io',
    withCredentials: true,
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  })
}
/** 命令不自动重放，断线立即拒绝，超时由会话 hook 拉取快照校准。 */
export async function sendRoomCommand<K extends keyof RoomCommands>(
  socket: Socket<ServerRoomEvents, ClientRoomEvents>,
  command: K,
  payload: RoomCommands[K],
): Promise<RoomCommandResult> {
  if (!socket.connected) throw new RoomCommandError('NOT_CONNECTED', '房间正在重新连接')
  return new Promise((resolve, reject) => {
    // Socket.IO 的映射事件泛型不能保持动态索引的关联；只在已类型化边界适配一次。
    const emit = socket.timeout(20_000).emit.bind(socket) as (
      eventName: K,
      payload: RoomCommands[K],
      ack: (error: Error | null, result: RoomAck<RoomCommandResult>) => void,
    ) => void
    emit(command, payload, (error, result) => {
      if (error) {
        reject(new RoomCommandError('ACK_TIMEOUT', '操作确认超时，正在同步房间状态'))
        return
      }
      if (!result.ok) {
        reject(
          new RoomCommandError(result.error.code, result.error.message, result.retryAfter ?? null),
        )
        return
      }
      resolve(result.data)
    })
  })
}
