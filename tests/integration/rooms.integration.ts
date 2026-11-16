import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { io, type Socket } from 'socket.io-client'
import { eq, inArray } from 'drizzle-orm'
import type { AddressInfo } from 'node:net'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import type {
  ClientRoomEvents,
  ServerRoomEvents,
  RoomCommands,
  RoomAck,
  RoomCommandResult,
  RoomSnapshot,
} from '../../src/contracts/room'

process.env.POOL_AUTH_RATE_NAMESPACE = `pool:test:rooms:${randomUUID()}`
process.env.POOL_MUSIC_NAMESPACE = `pool:test:room-music:${randomUUID()}`
process.env.ROOM_INTERNAL_SECRET = randomUUID() + randomUUID()
// 重启扫描会重置在线投影；使用完整隔离 schema，绝不扫描开发库的真实房间。
const schemaName = `pool_rooms_test_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: process.env.DATABASE_URL })
await admin.query(`create schema "${schemaName}"`)
const isolatedURL = new URL(process.env.DATABASE_URL!)
isolatedURL.searchParams.set('options', `-c search_path=${schemaName}`)
process.env.DATABASE_URL = isolatedURL.href
const migrationClient = new Pool({ connectionString: isolatedURL.href })
for (const filename of (await readdir(new URL('../../drizzle/', import.meta.url)))
  .filter((name) => name.endsWith('.sql'))
  .sort()) {
  const migration = (
    await readFile(new URL(`../../drizzle/${filename}`, import.meta.url), 'utf8')
  ).replaceAll('"public".', `"${schemaName}".`)
  await migrationClient.query(migration)
}
await migrationClient.end()
const { db, pool } = await import('../../src/server/db')
const { user } = await import('../../src/server/db/schema')
const tables = await import('../../src/server/db/rooms-schema')
const { likedSongs } = await import('../../src/server/db/likes-schema')
const { handleAuthRequest } = await import('../../src/server/auth/handler')
const { authRedis } = await import('../../src/server/auth/rate-limit')
const { getRedis } = await import('../../src/server/redis')
const repo = await import('../../src/server/rooms/repository')
const roomService = await import('../../src/server/rooms/service')
const { createRoomSocketServer } = await import('../../src/server/rooms/socket-server')
const { POST: resolveTrack } = await import('../../src/app/api/internal/room-track/route')
const { GET: listRoute, POST: createRoute } = await import('../../src/app/api/rooms/route')
const { GET: historyRoute } = await import('../../src/app/api/room-history/route')
const { GET: detailRoute, DELETE: deleteRoute } = await import(
  '../../src/app/api/room-history/[roomId]/route'
)
const run = randomUUID(),
  base = process.env.BETTER_AUTH_URL!,
  users: { id: string; cookie: string }[] = [],
  roomIds: string[] = []
const clients: Socket<ServerRoomEvents, ClientRoomEvents>[] = []
let server: Awaited<ReturnType<typeof createRoomSocketServer>>, url: string

/** 实际 Node HTTP fixture 分别模拟网易云详情和 Web 内部音乐路由；不启动应用。 */
const web = createServer(async (request, response) => {
  const path = new URL(request.url!, 'http://localhost')
  if (path.pathname === '/song/detail') {
    const id = Number(path.searchParams.get('ids'))
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        code: 200,
        songs: [
          {
            id,
            name: `歌曲 ${id}`,
            dt: id === 999 ? 0 : id === 107 ? 100 : 120_000,
            ar: [{ name: '作者' }],
            al: { name: '专辑', picUrl: 'https://p1.music.126.net/test.jpg' },
          },
        ],
      }),
    )
    return
  }
  let body = ''
  for await (const chunk of request) body += chunk
  const result = await resolveTrack(
    new Request(`http://localhost${request.url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pool-room-secret': String(request.headers['x-pool-room-secret'] ?? ''),
      },
      body,
    }),
  )
  response.writeHead(result.status, Object.fromEntries(result.headers))
  response.end(await result.text())
})

/** 本次随机邮箱注册；不打印 Cookie，测试后仅删除本次账号。 */
async function register(label: string) {
  if (!authRedis.isReady) await authRedis.connect()
  const keys = await authRedis.keys(`${process.env.POOL_AUTH_RATE_NAMESPACE}:*`)
  if (keys.length) await authRedis.del(keys)
  const response = await handleAuthRequest(
    new Request(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `u-${randomUUID()}-${run}@pool-test.example`,
        password: 'Test-password-123!',
        name: label,
      }),
    }),
  )
  assert.equal(response.status, 200, await response.clone().text())
  const data = await response.json(),
    account = {
      id: data.user.id as string,
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    }
  users.push(account)
  return account
}
/** Socket 使用真实 Cookie 握手；浏览器来源检查在测试中同样启用。 */
async function connect(cookie: string, origin = base) {
  const socket = io(url, {
    transports: ['websocket'],
    extraHeaders: { cookie, origin },
    reconnection: false,
    forceNew: true,
  })
  clients.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
  })
  return socket as Socket<ServerRoomEvents, ClientRoomEvents>
}
/** 动态命令的唯一测试传输适配，实际经过 Socket.IO 网络及 Zod 入口。 */
async function command<K extends keyof RoomCommands>(
  socket: Socket<ServerRoomEvents, ClientRoomEvents>,
  event: K,
  payload: RoomCommands[K],
) {
  return new Promise<RoomAck<RoomCommandResult>>((resolve, reject) => {
    const emit = socket.timeout(20_000).emit.bind(socket) as (
      name: K,
      data: RoomCommands[K],
      ack: (error: Error | null, data: RoomAck<RoomCommandResult>) => void,
    ) => void
    emit(event, payload, (error, result) => (error ? reject(error) : resolve(result)))
  })
}
/** 测试成功命令必须附带真实房间快照。 */
async function snapshot<K extends keyof RoomCommands>(
  socket: Socket<ServerRoomEvents, ClientRoomEvents>,
  event: K,
  payload: RoomCommands[K],
): Promise<RoomSnapshot> {
  const result = await command(socket, event, payload)
  assert.ok(result.ok, JSON.stringify(result))
  assert.ok(result.data.snapshot)
  return result.data.snapshot
}
/** Web 房间创建复用真实业务入口而非直接拼数据库记录。 */
async function create(account: (typeof users)[number], password?: string) {
  const response = await createRoute(
    new Request(`${base}/api/rooms`, {
      method: 'POST',
      headers: { cookie: account.cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '测试房间',
        tag: '测试标签',
        maxMembers: 3,
        maxStageMembers: 2,
        ...(password ? { password } : {}),
      }),
    }),
  )
  assert.equal(response.status, 201, await response.clone().text())
  const data = (await response.json()).data
  roomIds.push(data.roomId)
  return data as Awaited<ReturnType<typeof roomService.createRoom>>
}

before(async () => {
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve))
  const fixtureURL = `http://127.0.0.1:${(web.address() as AddressInfo).port}`
  process.env.MUSIC_API_BASE_URL = fixtureURL
  process.env.ROOM_WEB_URL = fixtureURL
  const { readServerEnv } = await import('../../src/server/env')
  readServerEnv().MUSIC_API_BASE_URL = fixtureURL
  server = await createRoomSocketServer()
  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`
  await register('甲')
  await register('乙')
  await register('丙')
})
after(async () => {
  for (const client of clients) client.disconnect()
  if (server) await server.close()
  await new Promise<void>((resolve) => web.close(() => resolve()))
  if (roomIds.length) await db.delete(tables.rooms).where(inArray(tables.rooms.id, roomIds))
  if (users.length)
    await db.delete(user).where(
      inArray(
        user.id,
        users.map((u) => u.id),
      ),
    )
  const redis = await getRedis()
  for (const prefix of [process.env.POOL_AUTH_RATE_NAMESPACE, process.env.POOL_MUSIC_NAMESPACE]) {
    const keys = await redis.keys(`${prefix}:*`)
    if (keys.length) await redis.del(keys)
  }
  if (authRedis.isOpen) await authRedis.close()
  if (redis.isOpen) await redis.quit()
  await pool.end()
  await admin.query(`drop schema "${schemaName}" cascade`)
  await admin.end()
})

describe('真实一起听 HTTP、Socket.IO 与 PostgreSQL', { concurrency: false }, () => {
  it('握手拒绝无会话与外站来源，HTTP 也独立鉴权', async () => {
    await assert.rejects(connect(''))
    await assert.rejects(connect(users[0].cookie, 'https://evil.example'))
    assert.equal((await listRoute(new Request(`${base}/api/rooms`))).status, 401)
    assert.equal(
      (
        await resolveTrack(
          new Request(`${base}/api/internal/room-track`, { method: 'POST', body: '{}' }),
        )
      ).status,
      403,
    )
  })
  it('并发创建仍只有一个有效房间，密码房按完整房间号查询且遵循分页校验', async () => {
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        createRoute(
          new Request(`${base}/api/rooms`, {
            method: 'POST',
            headers: { cookie: users[2].cookie, origin: base, 'content-type': 'application/json' },
            body: JSON.stringify({
              name: '私密测试房间',
              tag: '测试标签',
              maxMembers: 3,
              maxStageMembers: 2,
              password: 'secret-room',
            }),
          }),
        ),
      ),
    )
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409])
    const created = (await responses.find((response) => response.status === 201)!.json()).data
    roomIds.push(created.roomId)
    assert.equal('passwordHash' in created, false)
    const rejected = await responses.find((response) => response.status === 409)!.json()
    assert.equal(rejected.error.code, 'ROOM_ALREADY_CREATED')
    const hidden = await listRoute(
      new Request(`${base}/api/rooms?q=${encodeURIComponent(created.name)}`, {
        headers: { cookie: users[0].cookie },
      }),
    )
    assert.deepEqual((await hidden.json()).data.rooms.items, [])
    const exact = await listRoute(
      new Request(`${base}/api/rooms?q=${created.roomCode}`, {
        headers: { cookie: users[0].cookie },
      }),
    )
    assert.equal((await exact.json()).data.rooms.items[0].roomId, created.roomId)
    const mine = await listRoute(
      new Request(`${base}/api/rooms`, { headers: { cookie: users[2].cookie } }),
    )
    assert.equal((await mine.json()).data.myRoom.roomId, created.roomId)
    const invalid = await listRoute(
      new Request(`${base}/api/rooms?limit=501`, { headers: { cookie: users[0].cookie } }),
    )
    assert.equal(invalid.status, 400)
    const owner = await connect(users[2].cookie)
    await snapshot(owner, 'room:join', { roomCode: created.roomCode, password: 'secret-room' })
    assert.equal((await command(owner, 'room:dissolve', {})).ok, true)
  })
  it('真实创建、密码与容量，失败加入不写历史，同房多连接只计一人', async () => {
    const room = await create(users[0], 'secret-room'),
      a = await connect(users[0].cookie),
      b = await connect(users[1].cookie),
      tab = await connect(users[0].cookie)
    const wrong = await command(b, 'room:join', { roomCode: room.roomCode, password: 'wrong' })
    assert.equal(wrong.ok, false)
    assert.equal((await roomService.listHistory(users[1].id)).length, 0)
    await snapshot(a, 'room:join', { roomCode: room.roomCode, password: 'secret-room' })
    await snapshot(b, 'room:join', { roomCode: room.roomCode, password: 'secret-room' })
    const state = await snapshot(tab, 'room:join', {
      roomCode: room.roomCode,
      password: 'secret-room',
    })
    assert.equal(state.members.length, 2)
    await command(tab, 'room:leave', {})
    assert.equal((await snapshot(a, 'room:sync', {})).members.length, 2)
    await command(b, 'room:leave', {})
    await command(a, 'room:dissolve', {})
  })
  it('房间人数与设置约束、强制下台和踢人都校验当前房主', async () => {
    const room = await create(users[0]),
      a = await connect(users[0].cookie),
      b = await connect(users[1].cookie),
      c = await connect(users[2].cookie)
    await snapshot(a, 'room:join', { roomCode: room.roomCode })
    const settings = {
      name: '更新房间',
      tag: '测试标签',
      maxMembers: 2,
      maxStageMembers: 2,
      passwordAction: 'keep' as const,
    }
    await snapshot(a, 'room:update-settings', settings)
    await snapshot(b, 'room:join', { roomCode: room.roomCode })
    assert.equal((await command(c, 'room:join', { roomCode: room.roomCode })).ok, false)
    assert.equal((await command(b, 'room:update-settings', settings)).ok, false)
    await snapshot(a, 'room:update-settings', { ...settings, maxMembers: 3 })
    await snapshot(c, 'room:join', { roomCode: room.roomCode })
    assert.equal((await command(a, 'room:update-settings', settings)).ok, false)
    await snapshot(a, 'room:stage:join', {})
    await snapshot(b, 'room:stage:join', {})
    assert.equal(
      (await command(a, 'room:update-settings', { ...settings, maxMembers: 3, maxStageMembers: 1 }))
        .ok,
      false,
    )
    assert.equal((await command(b, 'room:stage:leave', { targetUserId: users[0].id })).ok, false)
    await snapshot(a, 'room:stage:leave', { targetUserId: users[1].id })
    await snapshot(a, 'room:update-settings', { ...settings, maxMembers: 3, maxStageMembers: 1 })
    const kicked = new Promise<string>((resolve) =>
      c.once('room:forced-leave', (event) => resolve(event.reason)),
    )
    await snapshot(a, 'room:kick-member', { targetUserId: users[2].id })
    assert.equal(await kicked, 'kicked')
    assert.equal((await command(c, 'room:chat:send', { content: '不能写入' })).ok, false)
    assert.equal((await command(b, 'room:dissolve', {})).ok, false)
    await command(a, 'room:dissolve', {})
  })
  it('权威时长、独立歌单、轮播、旧版本报告、投票与聊天限流', async () => {
    const room = await create(users[0]),
      a = await connect(users[0].cookie),
      b = await connect(users[1].cookie),
      c = await connect(users[2].cookie)
    await snapshot(a, 'room:join', { roomCode: room.roomCode })
    await snapshot(b, 'room:join', { roomCode: room.roomCode })
    await snapshot(c, 'room:join', { roomCode: room.roomCode })
    assert.equal(
      (await command(a, 'room:playlist:add', { source: 'netease', source_id: '999' })).ok,
      false,
    )
    let state = await snapshot(a, 'room:playlist:add', { source: 'netease', source_id: '101' })
    assert.equal(state.myPlaylist[0].track.duration_ms, 120000)
    assert.equal(
      (await command(a, 'room:playlist:add', { source: 'netease', source_id: '101' })).ok,
      false,
    )
    await snapshot(a, 'room:playlist:add', { source: 'netease', source_id: '102' })
    await snapshot(b, 'room:playlist:add', { source: 'netease', source_id: '103' })
    state = await snapshot(a, 'room:stage:join', {})
    assert.equal(state.playback.activeMemberId, users[0].id)
    assert.equal(state.playback.track?.source_id, '102')
    assert.ok(state.playback.startedAt! - Date.now() > 3000)
    const first = state.playback
    await snapshot(b, 'room:stage:join', {})
    assert.equal((await command(c, 'room:stage:join', {})).ok, false)
    state = await snapshot(a, 'room:playback:media-error', {
      version: first.version - 1,
      itemId: first.currentItemId!,
    })
    assert.equal(state.playback.version, first.version)
    state = await snapshot(c, 'room:playback:media-error', {
      version: first.version,
      itemId: first.currentItemId!,
    })
    assert.equal(state.playback.version, first.version)
    state = await snapshot(b, 'room:playback:vote-skip', {})
    assert.equal(state.playback.votes.length, 1)
    state = await snapshot(b, 'room:playback:vote-skip', {})
    assert.equal(state.playback.votes.length, 1)
    state = await snapshot(c, 'room:playback:vote-skip', {})
    assert.equal(state.playback.activeMemberId, users[1].id)
    assert.equal((await command(a, 'room:playback:skip', {})).ok, false)
    state = await snapshot(b, 'room:playback:skip', {})
    assert.equal(state.playback.track?.source_id, '101')
    const bad = await command(a, 'room:chat:send', { content: '😀'.repeat(121) })
    assert.equal(bad.ok, false)
    for (let i = 0; i < 5; i++)
      assert.ok((await command(a, 'room:chat:send', { content: `消息${i}` })).ok)
    const limited = await command(a, 'room:chat:send', { content: '超限' })
    assert.equal(limited.ok, false)
    assert.ok(limited.retryAfter)
    assert.equal((await snapshot(b, 'room:sync', {})).messages.length, 5)
    await command(a, 'room:dissolve', {})
  })
  it('导入真实收藏、容量并发、条目排序、当前节目不受清空影响', async () => {
    const room = await create(users[0]),
      a = await connect(users[0].cookie),
      tab = await connect(users[0].cookie)
    await snapshot(a, 'room:join', { roomCode: room.roomCode })
    await snapshot(tab, 'room:join', { roomCode: room.roomCode })
    await repo.editPlaylist(users[0].id, () => [])
    const track = {
      source: 'netease' as const,
      source_id: '101',
      title: '收藏',
      author: null,
      album: null,
      duration_ms: 120000,
      cover_url: null,
      extra: null,
    }
    await db.insert(likedSongs).values([
      { ...track, userId: users[0].id },
      { ...track, source_id: 'no-duration', duration_ms: null, userId: users[0].id },
    ])
    const result = await command(a, 'room:playlist:import-liked', {})
    assert.ok(result.ok)
    assert.equal(result.data.imported?.added, 1)
    assert.equal(result.data.imported?.failed, 1)
    await snapshot(a, 'room:playlist:add', { source: 'netease', source_id: '104' })
    let state = await snapshot(a, 'room:sync', {})
    const itemId = state.myPlaylist[0].itemId
    state = await snapshot(a, 'room:playlist:reorder', { itemId, toIndex: 1 })
    assert.equal(state.myPlaylist[1].itemId, itemId)
    await snapshot(a, 'room:playlist:remove', { itemId })
    state = await snapshot(a, 'room:stage:join', {})
    const version = state.playback.version
    state = await snapshot(a, 'room:playlist:clear', {})
    assert.equal(state.myPlaylist.length, 0)
    assert.equal(state.playback.version, version)
    await repo.editPlaylist(users[0].id, () =>
      Array.from({ length: 499 }, (_, i) => ({
        itemId: randomUUID(),
        position: i,
        track: { ...track, source_id: `seed-${i}` },
      })),
    )
    const results = await Promise.all([
      command(a, 'room:playlist:add', { source: 'netease', source_id: '105' }),
      command(tab, 'room:playlist:add', { source: 'netease', source_id: '106' }),
    ])
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.equal((await repo.getPlaylist(users[0].id)).length, 500)
    await command(a, 'room:dissolve', {})
  })
  it('目标验证失败保留旧房，确认切换强退旧连接，房主转给最早成员', async () => {
    const room = await create(users[0]),
      other = await create(users[1], 'secret-other')
    const a = await connect(users[0].cookie),
      tab = await connect(users[0].cookie),
      b = await connect(users[1].cookie)
    await snapshot(a, 'room:join', { roomCode: room.roomCode })
    await snapshot(tab, 'room:join', { roomCode: room.roomCode })
    await snapshot(b, 'room:join', { roomCode: room.roomCode })
    assert.equal(
      (await command(a, 'room:switch', { roomCode: other.roomCode, password: 'wrong' })).ok,
      false,
    )
    assert.equal((await snapshot(tab, 'room:sync', {})).room.roomCode, room.roomCode)
    const notice = new Promise<string>((resolve) =>
      tab.once('room:forced-leave', (event) => resolve(event.reason)),
    )
    await snapshot(a, 'room:switch', { roomCode: other.roomCode, password: 'secret-other' })
    assert.equal(await notice, 'switched')
    assert.equal((await snapshot(b, 'room:sync', {})).room.ownerId, users[1].id)
    assert.equal((await command(tab, 'room:sync', {})).ok, false)
    await command(a, 'room:leave', {})
    await command(b, 'room:dissolve', {})
    const owner = await connect(users[1].cookie)
    await snapshot(owner, 'room:join', { roomCode: other.roomCode, password: 'secret-other' })
    await command(owner, 'room:dissolve', {})
  })
  it('成功加入历史数据库最多五十条，删除凭证不删除归档', async () => {
    const now = Date.now()
    const seeded = Array.from({ length: 52 }, () => ({
      id: randomUUID(),
      code: `test-${randomUUID()}`,
      ownerId: users[0].id,
      createdBy: users[0].id,
      name: '历史房间',
      tag: '测试标签',
      maxMembers: 3,
      maxStageMembers: 2,
      status: 'ended' as const,
      endedAt: new Date(now),
      expiresAt: new Date(now + roomService.ARCHIVE_MS),
      emptyExpiresAt: new Date(now + roomService.EMPTY_ROOM_MS),
    }))
    roomIds.push(...seeded.map((r) => r.id))
    await db.insert(tables.rooms).values(seeded)
    for (const row of seeded) {
      await roomService.recordRoomJoin((await repo.findRoom(row.code))!, users[2].id, 0, new Date())
      await db
        .update(tables.roomMembers)
        .set({ leftAt: new Date() })
        .where(eq(tables.roomMembers.roomId, row.id))
    }
    assert.equal((await roomService.listHistory(users[2].id)).length, 50)
    const id = seeded.at(-1)!.id
    const context = { params: Promise.resolve({ roomId: id }) }
    assert.equal(
      (
        await detailRoute(
          new Request(`${base}/api/room-history/${id}`, { headers: { cookie: users[0].cookie } }),
          context,
        )
      ).status,
      403,
    )
    assert.equal(
      (
        await deleteRoute(
          new Request(`${base}/api/room-history/${id}`, {
            method: 'DELETE',
            headers: { cookie: users[2].cookie, origin: base },
          }),
          context,
        )
      ).status,
      200,
    )
    assert.ok(await repo.findRoom(seeded.at(-1)!.code))
    assert.equal((await roomService.listHistory(users[2].id)).length, 49)
    assert.equal(
      (
        await historyRoute(
          new Request(`${base}/api/room-history`, { headers: { cookie: users[2].cookie } }),
        )
      ).status,
      200,
    )
  })
  it('预加载不计已播放，服务端自然结束推进并落库，重连取得同一节目', async () => {
    const room = await create(users[0]),
      a = await connect(users[0].cookie),
      b = await connect(users[1].cookie)
    await snapshot(a, 'room:join', { roomCode: room.roomCode })
    await snapshot(b, 'room:join', { roomCode: room.roomCode })
    await snapshot(a, 'room:playlist:clear', {})
    await snapshot(a, 'room:playlist:add', { source: 'netease', source_id: '107' })
    const state = await snapshot(a, 'room:stage:join', {})
    assert.equal(
      (
        await db
          .select()
          .from(tables.roomPlayedSongs)
          .where(eq(tables.roomPlayedSongs.roomId, room.roomId))
      ).length,
      0,
    )
    const advanced = new Promise<RoomSnapshot['playback']>((resolve) =>
      b.on('room:state', (incoming) => {
        if (incoming.playback.version > state.playback.version) resolve(incoming.playback)
      }),
    )
    const next = await advanced
    assert.equal(next.version, state.playback.version + 1)
    assert.equal(
      (
        await db
          .select()
          .from(tables.roomPlayedSongs)
          .where(eq(tables.roomPlayedSongs.roomId, room.roomId))
      ).length,
      1,
    )
    await command(b, 'room:leave', {})
    b.disconnect()
    const reconnected = await connect(users[1].cookie),
      restored = await snapshot(reconnected, 'room:join', { roomCode: room.roomCode })
    assert.equal(restored.playback.version, next.version)
    assert.equal(restored.playback.startedAt, next.startedAt)
    await command(a, 'room:dissolve', {})
  })
  it('服务重启清空在线与播放，保留歌单历史以及原空房截止时间', async () => {
    const room = await create(users[0]),
      a = await connect(users[0].cookie)
    await snapshot(a, 'room:join', { roomCode: room.roomCode })
    await snapshot(a, 'room:stage:join', {})
    const before = await repo.getPlaylist(users[0].id),
      history = await roomService.listHistory(users[0].id)
    const empty = await roomService.createRoom(users[1].id, {
      name: '空房测试',
      tag: '测试标签',
      maxMembers: 3,
      maxStageMembers: 2,
    })
    roomIds.push(empty.roomId)
    const expiry = (await repo.findRoom(empty.roomCode))!.emptyExpiresAt.getTime()
    // 模拟进程被终止后的磁盘残留，不启动第二个应用进程。
    await server.close()
    await db.update(tables.rooms).set({ memberCount: 1 }).where(eq(tables.rooms.id, room.roomId))
    server = await createRoomSocketServer()
    await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`
    assert.equal((await repo.findRoom(empty.roomCode))!.emptyExpiresAt.getTime(), expiry)
    assert.deepEqual(await repo.getPlaylist(users[0].id), before)
    assert.deepEqual(
      (await roomService.listHistory(users[0].id)).map((r) => [r.roomId, r.lastJoinedAt]),
      history.map((r) => [r.roomId, r.lastJoinedAt]),
    )
    const again = await connect(users[0].cookie),
      state = await snapshot(again, 'room:join', { roomCode: room.roomCode })
    assert.equal(state.stageIds.length, 0)
    assert.equal(state.playback.status, 'idle')
    assert.equal(state.members.length, 1)
    await command(again, 'room:dissolve', {})
    const owner = await connect(users[1].cookie)
    await snapshot(owner, 'room:join', { roomCode: empty.roomCode })
    await command(owner, 'room:dissolve', {})
  })
  it('空房到期归档，七天截止立即拒绝读取并级联清理', async () => {
    const room = await create(users[0]),
      a = await connect(users[0].cookie)
    await snapshot(a, 'room:join', { roomCode: room.roomCode })
    await command(a, 'room:leave', {})
    const emptyDeadline = new Date(Date.now() - 1)
    await db
      .update(tables.rooms)
      .set({ emptyExpiresAt: emptyDeadline })
      .where(eq(tables.rooms.id, room.roomId))
    await server.service.sweep()
    const row = (await repo.findRoom(room.roomCode))!
    assert.equal(row.status, 'ended')
    assert.equal(row.endedAt!.getTime(), emptyDeadline.getTime())
    assert.equal(row.expiresAt!.getTime() - row.endedAt!.getTime(), roomService.ARCHIVE_MS)
    await db
      .update(tables.rooms)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(tables.rooms.id, room.roomId))
    await assert.rejects(roomService.historyDetail(users[0].id, room.roomId))
    await server.service.sweep()
    assert.equal(await repo.findRoom(room.roomCode), undefined)
    const records = await db
      .select()
      .from(tables.roomHistory)
      .where(eq(tables.roomHistory.roomId, room.roomId))
    assert.equal(records.length, 0)
  })
  it('在线会话被撤销后下一命令拒绝，并清理该连接', async () => {
    const a = await connect(users[2].cookie)
    await handleAuthRequest(
      new Request(`${base}/api/auth/sign-out`, {
        method: 'POST',
        headers: { cookie: users[2].cookie, origin: base, 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    const left = new Promise<void>((resolve) => a.once('disconnect', () => resolve()))
    // 会话失效时服务端主动断开，ack 不保证在断开前送达。
    a.emit('room:sync', {}, () => undefined)
    await left
  })
})
