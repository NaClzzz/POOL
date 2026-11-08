import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

// 此测试显式要求源码音源已启动；不启动 POOL Web，也不使用个人网易云 Cookie。
process.env.POOL_MUSIC_NAMESPACE = `pool:test:live:${randomUUID()}`
process.env.POOL_AUTH_RATE_NAMESPACE = `pool:test:live-auth:${randomUUID()}`
const { musicService } = await import('../../src/server/music/service')
const { likesRequest, importLikes } = await import('../../src/server/likes/handlers')
const { handleAuthRequest } = await import('../../src/server/auth/handler')
const { db, pool } = await import('../../src/server/db')
const { user } = await import('../../src/server/db/schema')
const { redis, getRedis } = await import('../../src/server/redis')
const origin = process.env.BETTER_AUTH_URL!
let userId: string | undefined
let cookie = ''

/** 普通业务请求仍经过真实会话校验，测试账号仅属于本次运行。 */
function req(path: string, body?: unknown) {
  return new Request(`${origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, origin, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

after(async () => {
  if (userId) await db.delete(user).where(eq(user.id, userId))
  const client = await getRedis()
  for (const prefix of [process.env.POOL_MUSIC_NAMESPACE, process.env.POOL_AUTH_RATE_NAMESPACE]) {
    const keys = await client.keys(`${prefix}:*`)
    if (keys.length) await client.del(keys)
  }
  if (redis.isOpen) await redis.close()
  await pool.end()
})

describe('运行中的网易云源码匿名服务', { concurrency: false }, () => {
  it('真实搜索、详情和歌词通过统一契约返回', async () => {
    const search = await musicService.search('netease', '海阔天空', 0, 3)
    assert.equal(search.items.length, 3)
    assert.ok(
      search.items.every((track) => track.source === 'netease' && track.title && track.duration_ms),
    )
    const track = await musicService.getTrack('netease', '33894312')
    assert.equal(track.source_id, '33894312')
    assert.ok(track.duration_ms! > 24000)
    const lyrics = await musicService.getLyrics('netease', track.source_id)
    assert.ok(lyrics.lrc && lyrics.lrc.length > 0)
    console.log(`真实曲目：${track.title}，资料时长 ${track.duration_ms}ms`)
  })

  it('真实播放资源支持 HTTPS 与分段读取，不返回演示音频', async () => {
    const resource = await musicService.resolvePlayback('netease', '33894312')
    assert.match(resource.url, /^https:\/\/[^/]+\.music\.126\.net\//)
    assert.equal(resource.delivery, 'direct')
    const response = await fetch(resource.url, {
      headers: { Range: 'bytes=0-1023' },
      signal: AbortSignal.timeout(20000),
    })
    assert.ok([200, 206].includes(response.status), `音频状态 ${response.status}`)
    const reader = response.body!.getReader()
    const first = await reader.read()
    assert.ok(first.value && first.value.byteLength > 0)
    await reader.cancel()
    console.log(`音频读取：HTTP ${response.status}，${response.headers.get('content-type')}`)
  })

  it('真实歌单分页、持久导入和重复导入可用，结束清理测试账号', async () => {
    const link = 'https://music.163.com/#/playlist?id=3778678'
    const first = await musicService.getPlaylistTracks('netease', link, 0, 3)
    assert.equal(first.tracks.items.length, 3)
    const registered = await handleAuthRequest(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          email: `music-live-${randomUUID()}@pool-test.example`,
          name: '实测',
          password: 'Test-password-123!',
        }),
      }),
    )
    assert.equal(registered.status, 200)
    userId = (await registered.json()).user.id
    cookie = registered.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    const result = await importLikes(req('/api/likes/import', { source: 'netease', url: link }))
    assert.equal(result.status, 200, await result.clone().text())
    const imported = (await result.json()).data
    assert.ok(imported.added > 0 && imported.added <= 500)
    const list = (await (await likesRequest(req('/api/likes?limit=500'))).json()).data
    assert.equal(list.total, imported.added)
    assert.deepEqual(
      list.items.slice(0, 3).map((item: { source_id: string }) => item.source_id),
      first.tracks.items.map((item) => item.source_id),
    )
    const duplicate = await importLikes(req('/api/likes/import', { source: 'netease', url: link }))
    assert.equal(duplicate.status, 200)
    assert.equal((await duplicate.json()).data.added, 0)
    console.log(
      `真实歌单：${first.playlist.title}，导入 ${imported.added} 首，失败 ${imported.failed} 首`,
    )
  })
})
