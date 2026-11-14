import { createRoomSocketServer } from '../src/server/rooms/socket-server'
import { pool } from '../src/server/db'
import { getRedis } from '../src/server/redis'

const server = await createRoomSocketServer()
server.httpServer.listen(server.config.SOCKET_PORT, server.config.SOCKET_HOST, () =>
  console.log(`[rooms] listening ${server.config.SOCKET_HOST}:${server.config.SOCKET_PORT}`),
)
/** 进程终止统一释放端口、连接池和任务。 */
async function shutdown() {
  await server.close()
  await pool.end()
  const redis = await getRedis().catch(() => null)
  if (redis?.isOpen) await redis.quit()
  process.exit(0)
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
