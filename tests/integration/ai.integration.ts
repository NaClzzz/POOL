import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { before, after, describe, it } from 'node:test'
import { Pool } from 'pg'
import { eq } from 'drizzle-orm'
import type { Track } from '../../src/contracts/domain'

// 所有表及 Redis key 隔离；不清理开发用户、房间或共享缓存。
const schemaName = `pool_ai_test_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: process.env.DATABASE_URL })
await admin.query(`create schema "${schemaName}"`)
const databaseURL = new URL(process.env.DATABASE_URL!)
databaseURL.searchParams.set('options', `-c search_path=${schemaName}`)
process.env.DATABASE_URL = databaseURL.href
const migration = new Pool({ connectionString: databaseURL.href })
for (const file of (await readdir(new URL('../../drizzle/', import.meta.url)))
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  await migration.query(
    (await readFile(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8')).replaceAll(
      '"public".',
      `"${schemaName}".`,
    ),
  )
}
await migration.end()
const namespace = `pool:test:ai:${randomUUID()}`
process.env.POOL_AI_NAMESPACE = namespace
process.env.POOL_AUTH_RATE_NAMESPACE = `${namespace}:auth`
process.env.POOL_MUSIC_NAMESPACE = `${namespace}:music`
process.env.DASHSCOPE_API_KEY = 'fixture-only-secret'
process.env.DASHSCOPE_MODEL = 'qwen3.8-flash'

/** 外部服务 fixture 仅模拟网络，SDK、会话、事务及限流均为真实实现。 */
const requests: {
  model: string
  max_tokens: number
  messages: { role: string; content: string }[]
  enable_thinking: boolean
}[] = []
let mode: 'normal' | 'slow' | 'length' | 'context' | 'disconnect' = 'normal'
const fixture = createServer(async (request, response) => {
  if (request.url?.startsWith('/lyric')) {
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        code: 200,
        lrc: { lyric: '[00:01]' + '完整歌词'.repeat(400) + '\n[00:02]歌词末尾' },
      }),
    )
    return
  }
  let body = ''
  for await (const chunk of request) body += chunk
  requests.push(JSON.parse(body))
  const currentMode = mode
  if (currentMode === 'context') {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        error: {
          message: 'maximum context length exceeded fixture-only-secret',
          type: 'invalid_request_error',
        },
      }),
    )
    return
  }
  if (currentMode === 'disconnect') {
    request.socket.destroy()
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  /** 发送标准 OpenAI 兼容数据，实际由已安装的 provider 转换。 */
  const chunk = (content: string | null, finish: string | null) =>
    response.write(
      `data: ${JSON.stringify({
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'qwen3.8-flash',
        choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
      })}\n\n`,
    )
  chunk('一起听见', null)
  await new Promise((resolve) => setTimeout(resolve, currentMode === 'slow' ? 250 : 15))
  if (response.destroyed) return
  chunk('音乐和聊天的回忆。', null)
  chunk(null, currentMode === 'length' ? 'length' : 'stop')
  response.end('data: [DONE]\n\n')
})
await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
const fixtureURL = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`
process.env.MUSIC_API_BASE_URL = fixtureURL
process.env.DASHSCOPE_BASE_URL = fixtureURL

const { db, pool } = await import('../../src/server/db')
const { rooms, roomHistory, roomPlayedSongs, roomMessages } = await import(
  '../../src/server/db/rooms-schema'
)
const { roomSummaries } = await import('../../src/server/db/ai-schema')
const { likedSongs } = await import('../../src/server/db/likes-schema')
const { handleAuthRequest } = await import('../../src/server/auth/handler')
const { getRedis, redis } = await import('../../src/server/redis')
const { playlistAnalysisHandler, getSummaryHandler, generateSummaryHandler } = await import(
  '../../src/server/ai/handlers'
)
const { claimRoomSummary } = await import('../../src/server/ai/service')
const { finishSummary } = await import('../../src/server/ai/repository')
const { chargeAiQuota, acquireAiTask } = await import('../../src/server/ai/runtime')
const { deleteHistory } = await import('../../src/server/rooms/service')
const { deleteArchivesBefore } = await import('../../src/server/rooms/repository')
const base = process.env.BETTER_AUTH_URL!
/** 测试账号通过真实认证入口建立 Cookie。 */
type Account = { id: string; cookie: string }
let a: Account, b: Account

/** 注册身份不绕过 HTTP 会话校验。 */
async function register(): Promise<Account> {
  const response = await handleAuthRequest(
    new Request(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `ai-${randomUUID()}@pool.test`,
        password: 'Test-password-123!',
        name: '测试成员',
      }),
    }),
  )
  assert.equal(response.status, 200)
  return {
    id: (await response.json()).user.id,
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  }
}
/** 请求不传用户 ID，只由 Cookie 确定调用者。 */
function req(account: Account, method = 'POST', signal?: AbortSignal) {
  return new Request(`${base}/api/ai/test`, {
    method,
    headers: { cookie: account.cookie, origin: base },
    signal,
  })
}
/** 房间参数格式与 Next 动态路由一致。 */
function context(roomId: string) {
  return { params: Promise.resolve({ roomId }) }
}
/** 仅重置本测试专属 AI 额度，音乐缓存仍用于验证复用。 */
async function clearQuota() {
  const client = await getRedis()
  const keys = await client.keys(`${namespace}:*`)
  const quota = keys.filter((key) => !key.includes(':auth:') && !key.includes(':music:'))
  if (quota.length) await client.del(quota)
}
/** 统一歌曲测试快照；房间播放身份仍由版本唯一约束管理。 */
function track(id: number): Track {
  return {
    source: 'netease',
    source_id: String(id),
    title: `歌曲${id}`,
    author: '作者',
    album: '测试专辑',
    duration_ms: 1000,
    cover_url: null,
    extra: null,
  }
}
/** 归档输入按固定时间顺序落库，方便验证最新二百条边界。 */
async function seedRoom(songCount = 1, chatCount = 1, active = false) {
  const id = randomUUID(),
    now = Date.now()
  await db.insert(rooms).values({
    id,
    code: `test-${id}`,
    name: '回忆房间',
    tag: '测试',
    ownerId: a.id,
    createdBy: a.id,
    maxMembers: 10,
    maxStageMembers: 5,
    status: active ? 'active' : 'ended',
    emptyExpiresAt: new Date(now),
    endedAt: active ? null : new Date(now),
    expiresAt: active ? null : new Date(now + 86400_000),
  })
  await db.insert(roomHistory).values(
    [a, b].map((u) => ({
      roomId: id,
      userId: u.id,
      firstJoinedAt: new Date(),
      lastJoinedAt: new Date(),
    })),
  )
  if (songCount)
    await db.insert(roomPlayedSongs).values(
      Array.from({ length: songCount }, (_, i) => ({
        id: randomUUID(),
        roomId: id,
        memberId: a.id,
        track: { ...track(200000 + (i % 7)), title: `播放${i}` },
        playbackVersion: i,
        playedAt: new Date(now - songCount * 1000 + i * 1000),
      })),
    )
  if (chatCount)
    await db.insert(roomMessages).values(
      Array.from({ length: chatCount }, (_, i) => ({
        id: randomUUID(),
        roomId: id,
        userId: a.id,
        senderName: '甲',
        content: `聊天${i}` + '聊'.repeat(100),
        createdAt: new Date(now - chatCount * 1000 + i * 1000),
      })),
    )
  return id
}
/** 等待后台持久结果，不以流结束代替数据库成功。 */
async function saved(roomId: string) {
  for (let i = 0; i < 100; i++) {
    const response = await getSummaryHandler(req(a, 'GET'), context(roomId))
    const value = (await response.json()).data
    if (value.status !== 'generating') return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('总结未在测试期限内完成')
}

before(async () => {
  a = await register()
  b = await register()
})
after(async () => {
  const client = await getRedis()
  const keys = await client.keys(`${namespace}:*`)
  if (keys.length) await client.del(keys)
  if (redis.isOpen) await redis.quit()
  await pool.end()
  fixture.closeAllConnections()
  await new Promise<void>((resolve) => fixture.close(() => resolve()))
  await admin.query(`drop schema "${schemaName}" cascade`)
  await admin.end()
})

describe('真实 AI SDK、账号、PostgreSQL 与 Redis', { concurrency: false }, () => {
  it('拒绝未登录、外站请求和空收藏，不启动模型', async () => {
    assert.equal(
      (await playlistAnalysisHandler(new Request(`${base}/api/ai/test`, { method: 'POST' })))
        .status,
      401,
    )
    assert.equal(
      (
        await playlistAnalysisHandler(
          new Request(`${base}/api/ai/test`, {
            method: 'POST',
            headers: { cookie: a.cookie, origin: 'https://evil.test' },
          }),
        )
      ).status,
      403,
    )
    assert.equal((await playlistAnalysisHandler(req(a))).status, 400)
    assert.equal(requests.length, 0)
  })
  it('收藏分析读取本人完整歌名、最多五份千字歌词并使用原生 SSE', async () => {
    await clearQuota()
    await db
      .insert(likedSongs)
      .values(Array.from({ length: 7 }, (_, i) => ({ ...track(100000 + i), userId: a.id })))
    await db
      .insert(likedSongs)
      .values({ ...track(199999), title: '另一用户的私有收藏', userId: b.id })
    const response = await playlistAnalysisHandler(req(a))
    assert.match(response.headers.get('Content-Type')!, /text\/event-stream/)
    assert.ok(response.headers.get('X-Request-Id'))
    const stream = await response.text()
    assert.match(stream, /text-delta/)
    assert.match(stream, /finish/)
    const request = requests.at(-1)!
    assert.equal(request.model, 'qwen3.8-flash')
    assert.equal(request.max_tokens, 1200)
    assert.equal(request.enable_thinking, false)
    const input = JSON.parse(
      request.messages.find((m) => m.role === 'user')!.content.split('\n')[1],
    )
    assert.equal(input.tracks.length, 7)
    assert.ok(input.tracks.every((s: Track) => s.author === '作者' && s.album === '测试专辑'))
    assert.equal(input.lyrics.length, 5)
    assert.ok(input.lyrics.every((s: Track) => s.author === '作者' && s.album === '测试专辑'))
    assert.ok(input.lyrics.every((s: { lyrics: string }) => s.lyrics.length === 1000))
    assert.ok(!JSON.stringify(input).includes('另一用户'))
  })
  it('活动房间、无历史与已过期房间不能生成或查看', async () => {
    const active = await seedRoom(1, 1, true)
    assert.equal((await generateSummaryHandler(req(a), context(active))).status, 409)
    const id = await seedRoom()
    await deleteHistory(b.id, id)
    assert.equal((await getSummaryHandler(req(b, 'GET'), context(id))).status, 403)
    await db
      .update(rooms)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(rooms.id, id))
    assert.equal((await generateSummaryHandler(req(a), context(id))).status, 410)
  })
  it('完整使用最新二百个节目、五首完整歌词和二百条完整聊天', async () => {
    await clearQuota()
    const id = await seedRoom(205, 205)
    const response = await generateSummaryHandler(req(a), context(id))
    const output = await response.text()
    assert.ok(!output.includes('errorText'), output)
    const state = await saved(id)
    assert.equal(state.status, 'succeeded')
    assert.match(state.content, /一起听见/)
    const request = requests.at(-1)!
    assert.equal(request.max_tokens, 2000)
    const input = JSON.parse(
      request.messages.find((m) => m.role === 'user')!.content.split('\n')[1],
    )
    assert.equal(input.tracks.length, 200)
    assert.equal(input.tracks[0].title, '播放5')
    assert.equal(input.tracks.at(-1).title, '播放204')
    assert.ok(input.tracks.every((s: Track) => s.author === '作者' && s.album === '测试专辑'))
    assert.equal(input.lyrics.length, 5)
    assert.ok(input.lyrics.every((s: Track) => s.author === '作者' && s.album === '测试专辑'))
    assert.ok(
      input.lyrics.every(
        (s: { lyrics: string }) => s.lyrics.endsWith('歌词末尾') && s.lyrics.length > 1000,
      ),
    )
    assert.equal(input.messages.length, 200)
    assert.match(input.messages[0].content, /^聊天5/)
    assert.ok(
      input.messages.reduce((n: number, m: { content: string }) => n + m.content.length, 0) > 12000,
    )
    assert.equal(
      (await db.select().from(roomMessages).where(eq(roomMessages.roomId, id))).length,
      205,
    )
    const before = requests.length
    const shared = await generateSummaryHandler(req(b), context(id))
    assert.match(shared.headers.get('Content-Type')!, /text\/event-stream/)
    const sharedStream = await shared.text()
    assert.match(sharedStream, /"finishReason":"stop"/)
    assert.ok(!sharedStream.includes('text-delta'))
    assert.ok(!sharedStream.includes(state.content))
    assert.equal(
      (await (await getSummaryHandler(req(b, 'GET'), context(id))).json()).data.content,
      state.content,
    )
    assert.equal(requests.length, before)
    const bQuota = `${namespace}:summary:${createHash('sha256').update(b.id).digest('hex')}:*`
    assert.deepEqual(await (await getRedis()).keys(bQuota), [])
    await deleteHistory(a.id, id)
    assert.equal((await getSummaryHandler(req(a, 'GET'), context(id))).status, 403)
    assert.equal((await getSummaryHandler(req(b, 'GET'), context(id))).status, 200)
  })
  it('同房并发仅调用一次，客户端断开后后台仍保存', async () => {
    await clearQuota()
    mode = 'slow'
    const id = await seedRoom(),
      before = requests.length
    const controller = new AbortController()
    const first = await generateSummaryHandler(req(a, 'POST', controller.signal), context(id))
    const second = await generateSummaryHandler(req(b), context(id))
    assert.equal(second.status, 409)
    controller.abort()
    void first.body!.cancel()
    assert.equal((await saved(id)).status, 'succeeded')
    assert.equal(requests.length, before + 1)
    mode = 'normal'
  })
  it('总结按触发用户跨房限流，另一用户可生成，同用户分析额度独立', async () => {
    await clearQuota()
    const id = await seedRoom(),
      second = await seedRoom()
    await (await generateSummaryHandler(req(a), context(id))).text()
    const refused = await generateSummaryHandler(req(a), context(second))
    assert.equal(refused.status, 429)
    assert.ok(Number(refused.headers.get('Retry-After')) > 0)
    assert.equal((await saved(second)).status, 'failed')
    await (await generateSummaryHandler(req(b), context(second))).text()
    assert.equal((await saved(second)).status, 'succeeded')
    assert.equal((await playlistAnalysisHandler(req(a))).status, 200)
    // 完整读取，确保本次任务完成并释放资格。
    await new Promise((resolve) => setTimeout(resolve, 80))
  })
  it('失败重试可由其他参与者触发，截断内容不保存为成功', async () => {
    await clearQuota()
    const id = await seedRoom()
    mode = 'length'
    const text = await (await generateSummaryHandler(req(a), context(id))).text()
    assert.match(text, /输出上限/)
    assert.equal((await saved(id)).status, 'failed')
    const [row] = await db.select().from(roomSummaries).where(eq(roomSummaries.roomId, id))
    assert.equal(row.content, null)
    mode = 'normal'
    await (await generateSummaryHandler(req(b), context(id))).text()
    assert.equal((await saved(id)).status, 'succeeded')
  })
  it('上下文超限显式报错，供应商凭据和错误正文不泄露', async () => {
    await clearQuota()
    mode = 'context'
    const id = await seedRoom()
    const text = await (await generateSummaryHandler(req(a), context(id))).text()
    assert.match(text, /上下文/)
    assert.ok(!text.includes('fixture-only-secret'))
    assert.equal((await saved(id)).errorCode, 'AI_INPUT_TOO_LARGE')
    mode = 'normal'
  })
  it('过期生成资格可恢复，旧尝试不能回写覆盖新总结', async () => {
    const id = await seedRoom()
    const old = await claimRoomSummary(a.id, id)
    await db
      .update(roomSummaries)
      .set({ startedAt: new Date(Date.now() - 121000) })
      .where(eq(roomSummaries.roomId, id))
    assert.equal((await saved(id)).status, 'failed')
    const current = await claimRoomSummary(b.id, id)
    assert.equal(await finishSummary(id, old.attemptId!, '过时正文', null), false)
    assert.equal(await finishSummary(id, current.attemptId!, '当前正文', null), true)
    assert.equal((await saved(id)).content, '当前正文')
  })
  it('空输入不计次数，缺少密钥返回配置错误，且释放任务资格', async () => {
    await clearQuota()
    const empty = await seedRoom(0, 0)
    assert.equal((await generateSummaryHandler(req(a), context(empty))).status, 400)
    const original = process.env.DASHSCOPE_API_KEY
    delete process.env.DASHSCOPE_API_KEY
    assert.equal((await playlistAnalysisHandler(req(a))).status, 503)
    process.env.DASHSCOPE_API_KEY = original
    assert.equal((await playlistAnalysisHandler(req(a))).status, 200)
    await new Promise((resolve) => setTimeout(resolve, 80))
  })
  it('每日额度上限十次，限流拒绝不继续增加日额度', async () => {
    await clearQuota()
    const client = await getRedis(),
      hash = createHash('sha256').update(a.id).digest('hex')
    for (let i = 0; i < 10; i++) {
      await client.del(`${namespace}:summary:${hash}:minute`)
      await chargeAiQuota(a.id, 'summary')
    }
    await client.del(`${namespace}:summary:${hash}:minute`)
    await assert.rejects(chargeAiQuota(a.id, 'summary'), { code: 'RATE_LIMITED' })
    assert.equal(await client.get(`${namespace}:summary:${hash}:day`), '10')
  })
  it('全站满额不认领房间也不扣用户额度', async () => {
    await clearQuota()
    const completedRoom = await seedRoom()
    const attempt = await claimRoomSummary(a.id, completedRoom)
    await finishSummary(completedRoom, attempt.attemptId!, '已完成总结', null)
    const before = requests.length
    const releases = Array.from({ length: 10 }, (_, i) => acquireAiTask(`fixture:${i}`))
    try {
      const shared = await generateSummaryHandler(req(b), context(completedRoom))
      assert.match(shared.headers.get('Content-Type')!, /text\/event-stream/)
      assert.match(await shared.text(), /"finishReason":"stop"/)
      assert.equal(requests.length, before)
      const id = await seedRoom()
      assert.equal((await generateSummaryHandler(req(a), context(id))).status, 503)
      assert.equal((await saved(id)).status, 'idle')
    } finally {
      releases.forEach((release) => release())
    }
  })
  it('到期清理级联删除总结、聊天、节目和全部访问记录', async () => {
    const id = await seedRoom()
    const attempt = await claimRoomSummary(a.id, id)
    assert.equal(await finishSummary(id, attempt.attemptId!, '保存正文', null), true)
    await db
      .update(rooms)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(rooms.id, id))
    await deleteArchivesBefore(new Date())
    assert.equal(
      (await db.select().from(roomSummaries).where(eq(roomSummaries.roomId, id))).length,
      0,
    )
    assert.equal((await db.select().from(roomHistory).where(eq(roomHistory.roomId, id))).length, 0)
    assert.equal(
      (await db.select().from(roomMessages).where(eq(roomMessages.roomId, id))).length,
      0,
    )
    assert.equal(
      (await db.select().from(roomPlayedSongs).where(eq(roomPlayedSongs.roomId, id))).length,
      0,
    )
  })
})
