import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { after, beforeEach, describe, it } from 'node:test'
import { eq, inArray } from 'drizzle-orm'

/** 可控网易云上游用于验证转换、缓存和错误，不依赖外部曲库稳定性。 */
function song(id: number) {
  return {
    id,
    name: `歌曲 ${id}`,
    dt: 183456,
    ar: [{ name: '作者' }],
    al: { name: '专辑', picUrl: 'http://p1.music.126.net/test.jpg' },
  }
}
const hits: string[] = []
const fixture = createServer((request, response) => {
  const url = new URL(request.url!, 'http://localhost')
  hits.push(url.pathname + url.search)
  response.setHeader('Content-Type', 'application/json')
  // 保持一个短暂窗口，让并发导入和缓存合并测试覆盖真实竞争。
  setTimeout(() => {
    let result: unknown
    if (url.pathname === '/cloudsearch') {
      const q = url.searchParams.get('keywords')
      result =
        q === 'broken'
          ? { code: 200, result: { songs: 'invalid' } }
          : q === 'limited'
            ? { code: 429 }
            : {
                code: 200,
                result: {
                  songCount: 65,
                  songs: Array.from(
                    {
                      length: Math.min(
                        Number(url.searchParams.get('limit')),
                        65 - Number(url.searchParams.get('offset')),
                      ),
                    },
                    (_, i) => song(100001 + Number(url.searchParams.get('offset')) + i),
                  ),
                },
              }
    } else if (url.pathname === '/song/detail') {
      const ids = url.searchParams.get('ids')!.split(',').map(Number)
      result = { code: 200, songs: ids.filter((id) => id !== 999999999).map(song) }
    } else if (url.pathname === '/lyric') {
      result =
        Number(url.searchParams.get('id')) === 100004
          ? { code: 200 }
          : { code: 200, lrc: { lyric: '[00:00.00]歌词' }, tlyric: { lyric: '[00:00.00]翻译' } }
    } else if (url.pathname === '/song/url/v1') {
      const id = Number(url.searchParams.get('id'))
      result = {
        code: 200,
        data: [
          {
            id,
            code: 200,
            url: id === 100003 ? null : 'http://m801.music.126.net/test.mp3',
            type: 'mp3',
            expi: 1200,
            freeTrialInfo: id === 100002 ? { start: 0, end: 30 } : null,
          },
        ],
      }
    } else if (url.pathname === '/playlist/detail') {
      result = {
        code: 200,
        playlist: {
          id: Number(url.searchParams.get('id')),
          name: '测试歌单',
          coverImgUrl: null,
          trackCount: 600,
          trackIds: Array.from({ length: 600 }, (_, i) => ({ id: 110001 + i })),
        },
      }
    } else result = { code: 404 }
    response.end(JSON.stringify(result))
  }, 25)
})
await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
const address = fixture.address() as { port: number }
process.env.MUSIC_API_BASE_URL = `http://127.0.0.1:${address.port}`
process.env.POOL_MUSIC_NAMESPACE = `pool:test:music:${randomUUID()}`
process.env.POOL_AUTH_RATE_NAMESPACE = `pool:test:auth:${randomUUID()}`
const { handleAuthRequest } = await import('../../src/server/auth/handler')
const { musicQuery, musicPlayback, musicStream } = await import('../../src/server/music/handlers')
const { likesRequest, importLikes } = await import('../../src/server/likes/handlers')
const { likesService } = await import('../../src/server/likes/service')
const { db, pool } = await import('../../src/server/db')
const { user } = await import('../../src/server/db/schema')
const { likedSongs } = await import('../../src/server/db/likes-schema')
const { redis, getRedis } = await import('../../src/server/redis')
const origin = process.env.BETTER_AUTH_URL!
const users: string[] = []
let owner: { id: string; cookie: string }

/** 只清理本测试进程命名空间中的缓存／限流键，不清空共享 Redis。 */
async function clearKeys() {
  const client = await getRedis()
  for (const prefix of [process.env.POOL_MUSIC_NAMESPACE, process.env.POOL_AUTH_RATE_NAMESPACE]) {
    const keys = await client.keys(`${prefix}:*`)
    if (keys.length) await client.del(keys)
  }
}

/** 注册一次真实 Cookie 身份，使音乐与收藏接口均经过真实鉴权。 */
async function newUser() {
  const result = await handleAuthRequest(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `music-${randomUUID()}@pool-test.example`,
        password: 'Test-password-123!',
        name: '音乐测试',
      }),
    }),
  )
  assert.equal(result.status, 200)
  const body = await result.json()
  users.push(body.user.id)
  return {
    id: body.user.id as string,
    cookie: result.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; '),
  }
}

/** 构造与页面相同的普通业务请求，用户查询参数不能代替 Cookie。 */
function req(path: string, body?: unknown, method = body ? 'POST' : 'GET', cookie = owner.cookie) {
  return new Request(`${origin}${path}`, {
    method,
    headers: { cookie, origin, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

/** 收藏测试输入模拟被篡改的前端快照；服务端应改用可信详情。 */
function track(id: number) {
  return {
    source: 'netease' as const,
    source_id: String(id),
    title: '客户端假标题',
    author: null,
    album: null,
    cover_url: null,
    duration_ms: null,
    extra: null,
  }
}

beforeEach(async () => {
  await clearKeys()
  owner = await newUser()
})
after(async () => {
  if (users.length) await db.delete(user).where(inArray(user.id, users))
  await clearKeys()
  if (redis.isOpen) await redis.close()
  await pool.end()
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  )
})

describe('统一音乐服务、缓存与真实收藏事务', { concurrency: false }, () => {
  it('全部接口先验证会话，Bilibili 返回 501，不回退 mock', async () => {
    assert.equal(
      (
        await musicQuery(
          req('/api/music/search?source=netease&q=test', undefined, 'GET', ''),
          'search',
        )
      ).status,
      401,
    )
    assert.equal((await likesRequest(req('/api/likes', undefined, 'GET', ''))).status, 401)
    const response = await musicQuery(req('/api/music/search?source=bilibili&q=test'), 'search')
    assert.equal(response.status, 501)
    assert.equal((await response.json()).error.code, 'CAPABILITY_NOT_SUPPORTED')
  })

  it('搜索转换时长和封面，并合并并发未命中及命中缓存', async () => {
    const before = hits.filter((path) => path.startsWith('/cloudsearch')).length
    const replies = await Promise.all(
      Array.from({ length: 5 }, () =>
        musicQuery(req('/api/music/search?source=netease&q=cache&limit=2&offset=3'), 'search'),
      ),
    )
    const page = (await replies[0].json()).data
    assert.equal(page.total, 65)
    assert.equal(page.offset, 3)
    assert.equal(page.items[0].source_id, '100004')
    assert.equal(page.items[0].duration_ms, 183456)
    assert.match(page.items[0].cover_url, /^https:/)
    await musicQuery(req('/api/music/search?source=netease&q=cache&limit=2&offset=3'), 'search')
    assert.equal(hits.filter((path) => path.startsWith('/cloudsearch')).length - before, 1)
  })

  it('上游业务限流与格式错误区分于无结果；无歌词是成功的 null', async () => {
    let response = await musicQuery(req('/api/music/search?source=netease&q=limited'), 'search')
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error.code, 'UPSTREAM_RATE_LIMITED')
    response = await musicQuery(req('/api/music/search?source=netease&q=broken'), 'search')
    assert.equal((await response.json()).error.code, 'UPSTREAM_INVALID_RESPONSE')
    response = await musicQuery(req('/api/music/lyrics?source=netease&id=100004'), 'lyrics')
    assert.deepEqual((await response.json()).data, { lrc: null, translationLrc: null })
  })

  it('播放按统一引用解析，不启用解锁；试听和无地址明确不可播放', async () => {
    const result = await musicPlayback(
      req('/api/music/playback', { source: 'netease', source_id: '100001' }),
    )
    assert.equal(result.status, 200)
    const playback = (await result.json()).data
    assert.equal(playback.delivery, 'direct')
    assert.equal(playback.duration_ms, 183456)
    assert.match(playback.url, /^https:/)
    assert.ok(playback.expires_at)
    assert.ok(
      hits.some((path) => path.startsWith('/song/url/v1') && path.includes('unblock=false')),
    )
    for (const id of ['100002', '100003']) {
      const response = await musicPlayback(
        req('/api/music/playback', { source: 'netease', source_id: id }),
      )
      assert.equal(response.status, 422)
      assert.equal((await response.json()).error.code, 'TRACK_UNPLAYABLE')
    }
  })

  it('收藏写入可信快照，重复不改时间，列表稳定分页且只属于当前用户', async () => {
    const first = await likesRequest(req('/api/likes', { track: track(100001), userId: 'forged' }))
    assert.equal(first.status, 201)
    const original = (await first.json()).data.item
    assert.equal(original.title, '歌曲 100001')
    const duplicate = await likesRequest(req('/api/likes', { track: track(100001) }))
    assert.equal(duplicate.status, 200)
    assert.equal((await duplicate.json()).data.item.addedAt, original.addedAt)
    const other = await newUser()
    const foreign = await likesRequest(
      req(`/api/likes?userId=${owner.id}`, undefined, 'GET', other.cookie),
    )
    assert.equal((await foreign.json()).data.total, 0)
    const [row] = await db.select().from(likedSongs).where(eq(likedSongs.userId, owner.id))
    assert.equal(row.extra, null)
    assert.equal('url' in row, false)
    await likesRequest(req('/api/likes?source=netease&id=100001', undefined, 'DELETE'))
    await likesRequest(req('/api/likes?source=netease&id=100001', undefined, 'DELETE'))
    assert.equal((await likesService.list(owner.id, 0, 500)).total, 0)
  })

  it('并发新增与导入共享容量锁，数据库最终不超过 500 首', async () => {
    await db
      .insert(likedSongs)
      .values(Array.from({ length: 498 }, (_, i) => ({ userId: owner.id, ...track(2200000 + i) })))
    const responses = await Promise.all([
      ...[100001, 100002, 100003, 100004].map((id) =>
        likesRequest(req('/api/likes', { track: track(id) })),
      ),
      importLikes(
        req('/api/likes/import', {
          source: 'netease',
          url: 'https://music.163.com/playlist?id=2345',
        }),
      ),
    ])
    assert.ok(responses.every((response) => [200, 201, 409].includes(response.status)))
    const page = await likesService.list(owner.id, 0, 500)
    assert.equal(page.total, 500)
    assert.equal(new Set(page.items.map((item) => item.source_id)).size, 500)
  })

  it('导入按歌单顺序填满剩余容量，未读数量返回未知并拒绝同用户同时导入', async () => {
    await db
      .insert(likedSongs)
      .values(Array.from({ length: 497 }, (_, i) => ({ userId: owner.id, ...track(2300000 + i) })))
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        importLikes(
          req('/api/likes/import', {
            source: 'netease',
            url: 'https://music.163.com/#/playlist?id=5678',
          }),
        ),
      ),
    )
    assert.equal(responses.filter((response) => response.status === 200).length, 1)
    assert.equal(responses.filter((response) => response.status === 409).length, 1)
    const result = await responses.find((response) => response.status === 200)!.json()
    assert.equal(result.data.added, 3)
    assert.equal(result.data.remainingCapacity, 0)
    assert.equal(result.data.capacitySkipped, null)
    assert.equal(result.data.hasMore, true)
    assert.deepEqual(
      (await likesService.list(owner.id, 0, 3)).items.map((item) => item.source_id),
      ['110001', '110002', '110003'],
    )
  })

  it('缓存命中也扣用户请求额度，第 31 次搜索返回 429 和重试时间', async () => {
    const replies = await Promise.all(
      Array.from({ length: 31 }, () =>
        musicQuery(req('/api/music/search?source=netease&q=rate'), 'search'),
      ),
    )
    assert.equal(replies.filter((response) => response.status === 200).length, 30)
    const limited = replies.find((response) => response.status === 429)!
    assert.ok(Number(limited.headers.get('retry-after')) > 0)
  })

  it('Redis 限流故障时普通查询降级，批量导入返回 503', async (context) => {
    context.mock.method(redis, 'eval', async () => {
      throw new Error('injected redis failure')
    })
    const query = await musicQuery(req('/api/music/search?source=netease&q=fallback'), 'search')
    assert.equal(query.status, 200)
    const imported = await importLikes(
      req('/api/likes/import', {
        source: 'netease',
        url: 'https://music.163.com/playlist?id=9876',
      }),
    )
    assert.equal(imported.status, 503)
    assert.equal((await imported.json()).error.code, 'LIMITER_UNAVAILABLE')
  })

  it('音频代理保留 Range 和媒体响应，不接受任意取流地址', async (context) => {
    const original = globalThis.fetch
    context.mock.method(
      globalThis,
      'fetch',
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (new URL(String(input)).hostname.endsWith('.music.126.net')) {
          assert.equal(new Headers(init?.headers).get('range'), 'bytes=0-3')
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 206,
            headers: {
              'Content-Type': 'audio/mpeg',
              'Content-Range': 'bytes 0-3/100',
              'Accept-Ranges': 'bytes',
            },
          })
        }
        return original(input, init)
      },
    )
    const request = req('/api/music/stream?source=netease&id=100001&url=http://127.0.0.1/private')
    request.headers.set('Range', 'bytes=0-3')
    const response = await musicStream(request)
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-type'), 'audio/mpeg')
    assert.equal(response.headers.get('content-range'), 'bytes 0-3/100')
    assert.equal((await response.arrayBuffer()).byteLength, 4)
  })
})
