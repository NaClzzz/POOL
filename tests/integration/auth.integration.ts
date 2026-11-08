import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'

// 集成测试只创建本次随机邮箱的账号；限流键使用专用命名空间。
process.env.POOL_AUTH_RATE_NAMESPACE = `pool:test:auth:${randomUUID()}`
const { handleAuthRequest } = await import('../../src/server/auth/handler')
const { getAccount } = await import('../../src/server/account')
const { pool, db } = await import('../../src/server/db')
const { user, session, account } = await import('../../src/server/db/schema')
const { authRedis, authRateLimitStorage, AuthLimiterUnavailable } = await import(
  '../../src/server/auth/rate-limit'
)
const baseURL = process.env.BETTER_AUTH_URL!
const users: string[] = []
const run = randomUUID()
const password = 'Test-password-123!'

/** 直接调用真实 HTTP 处理器，无需启动 Next.js 或额外监听端口。 */
async function request(
  path: string,
  body?: Record<string, unknown>,
  cookie = '',
  extra: Record<string, string> = {},
) {
  return handleAuthRequest(
    new Request(`${baseURL}/api/auth${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { origin: baseURL, 'content-type': 'application/json', cookie, ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

/** 提取 HttpOnly 会话 Cookie 供测试客户端重放，不打印 token。 */
function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

/** 注册唯一测试账号，清理只依据本次返回的用户主键。 */
async function register(label: string) {
  const email = `${label}-${run}@pool-test.example`
  const response = await request('/sign-up/email', { email, password, name: `测试 ${label}` })
  assert.equal(response.status, 200, await response.clone().text())
  const data = await response.json()
  users.push(data.user.id)
  return { email, id: data.user.id as string, cookie: cookieOf(response), response }
}

/** 只删除当前测试专用的 Redis key，不清空生产或其他项目数据。 */
async function clearRateKeys() {
  if (!authRedis.isReady) await authRedis.connect()
  const keys = await authRedis.keys(`${process.env.POOL_AUTH_RATE_NAMESPACE}:*`)
  if (keys.length) await authRedis.del(keys)
}

beforeEach(clearRateKeys)
after(async () => {
  if (users.length) await db.delete(user).where(inArray(user.id, users))
  await clearRateKeys()
  if (authRedis.isOpen) await authRedis.close()
  await pool.end()
})

describe('真实 PostgreSQL、Cookie 会话与 Redis 账号集成', { concurrency: false }, () => {
  it('兼容 Next.js 运行时包装的请求对象，GET 与 POST 均不依赖原生实例身份', async () => {
    /** 模拟框架请求包装：保留 Web API 字段，但不继承当前运行时 Request。 */
    const wrap = (request: Request) =>
      ({
        url: request.url,
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        arrayBuffer: () => request.arrayBuffer(),
        toString: () => '[object Request]',
      }) as Request
    const sessionResponse = await handleAuthRequest(
      wrap(new Request(`${baseURL}/api/auth/get-session`)),
    )
    assert.equal(sessionResponse.status, 200)
    assert.equal(await sessionResponse.json(), null)
    const loginResponse = await handleAuthRequest(
      wrap(
        new Request(`${baseURL}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { origin: baseURL, 'content-type': 'application/json' },
          body: JSON.stringify({ email: `missing-wrapper-${run}@example.com`, password }),
        }),
      ),
    )
    assert.equal(loginResponse.status, 401)
  })

  it('未登录账号接口返回统一 401，并且认证未支持端点不可访问', async () => {
    const response = await getAccount(new Request(`${baseURL}/api/account?userId=someone-else`))
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.equal(body.error.code, 'UNAUTHENTICATED')
    assert.ok(body.requestId)
    assert.equal(
      (await request('/request-password-reset', { email: 'any@example.com' })).status,
      404,
    )
  })

  it('注册写入真实账号与密码哈希，设置 HttpOnly Cookie 并支持刷新读取', async () => {
    const result = await register('signup')
    assert.notEqual(result.id, result.email)
    assert.match(result.response.headers.get('set-cookie')!, /HttpOnly/i)
    assert.match(result.response.headers.get('set-cookie')!, /SameSite=Lax/i)
    const [credential] = await db.select().from(account).where(eq(account.userId, result.id))
    assert.ok(credential.password)
    assert.notEqual(credential.password, password)
    const response = await request('/get-session', undefined, result.cookie)
    const data = await response.json()
    assert.equal(data.user.id, result.id)
    assert.ok(
      Math.abs(new Date(data.session.expiresAt).getTime() - Date.now() - 7 * 86400000) < 10000,
    )
    const profile = await getAccount(
      new Request(`${baseURL}/api/account?userId=ignored`, { headers: { cookie: result.cookie } }),
    )
    const dto = await profile.json()
    assert.equal(dto.data.id, result.id)
    assert.equal(dto.data.email, result.email)
    assert.equal('token' in dto.data, false)
    assert.equal('password' in dto.data, false)
  })

  it('错误密码、未注册账号、短密码和空昵称被拒绝；重复邮箱不创建第二个账号', async () => {
    const result = await register('credentials')
    assert.equal(
      (await request('/sign-in/email', { email: result.email, password: 'incorrect-password' }))
        .status,
      401,
    )
    assert.equal(
      (await request('/sign-in/email', { email: `missing-${run}@example.com`, password })).status,
      401,
    )
    assert.equal(
      (
        await request('/sign-up/email', {
          email: `short-${run}@example.com`,
          password: '123',
          name: '测试',
        })
      ).status,
      400,
    )
    await clearRateKeys()
    assert.equal(
      (await request('/sign-up/email', { email: `blank-${run}@example.com`, password, name: '  ' }))
        .status,
      400,
    )
    await request('/sign-up/email', { email: result.email, password, name: '重复' })
    const existing = await db.select().from(user).where(eq(user.email, result.email))
    assert.equal(existing.length, 1)
  })

  it('退出会删除服务端会话，旧 Cookie 和篡改 Cookie 均无法继续使用', async () => {
    const result = await register('logout')
    assert.equal((await request('/sign-out', {}, result.cookie)).status, 200)
    assert.equal(await (await request('/get-session', undefined, result.cookie)).json(), null)
    assert.equal(
      (
        await getAccount(
          new Request(`${baseURL}/api/account`, { headers: { cookie: result.cookie } }),
        )
      ).status,
      401,
    )
    assert.equal(
      await (await request('/get-session', undefined, `${result.cookie}tampered`)).json(),
      null,
    )
  })

  it('过期会话拒绝访问，活跃超过一天后续期至新的七天', async () => {
    const result = await register('expiry')
    await db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(session.userId, result.id))
    assert.equal(await (await request('/get-session', undefined, result.cookie)).json(), null)
    const login = await request('/sign-in/email', { email: result.email, password })
    assert.equal(login.status, 200)
    const cookie = cookieOf(login)
    await db
      .update(session)
      .set({
        expiresAt: new Date(Date.now() + 5 * 86400000),
        updatedAt: new Date(Date.now() - 2 * 86400000),
      })
      .where(eq(session.userId, result.id))
    const refreshed = await request('/get-session', undefined, cookie)
    const data = await refreshed.json()
    assert.ok(new Date(data.session.expiresAt).getTime() > Date.now() + 6.9 * 86400000)
    assert.ok(refreshed.headers.get('set-cookie'))
  })

  it('不同账号会话隔离，指定另一 userId 不改变当前身份', async () => {
    const a = await register('account-a')
    const b = await register('account-b')
    for (const [current, other] of [
      [a, b],
      [b, a],
    ]) {
      const response = await getAccount(
        new Request(`${baseURL}/api/account?userId=${other.id}`, {
          headers: { cookie: current.cookie },
        }),
      )
      assert.equal((await response.json()).data.id, current.id)
    }
  })

  it('并发登录请求由 Redis 原子限流，伪造代理头不能绕过本地模式', async () => {
    const result = await register('rate')
    const responses = await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        request('/sign-in/email', { email: result.email, password }, '', {
          'x-forwarded-for': `192.0.2.${i}`,
          'x-pool-client-ip': `fake-${i}`,
        }),
      ),
    )
    assert.equal(responses.filter((response) => response.status === 200).length, 5)
    const limited = responses.filter((response) => response.status === 429)
    assert.equal(limited.length, 2)
    assert.ok(Number(limited[0].headers.get('retry-after')) > 0)
    for (const response of responses)
      if (response.status === 200) {
        const cookie = cookieOf(response)
        await request('/sign-out', {}, cookie)
      }
  })

  it('跨站来源不能注册或登录，资料修改也不能修改其他账号', async () => {
    assert.equal(
      (
        await request('/sign-in/email', { email: 'any@example.com', password }, '', {
          origin: 'https://evil.example',
        })
      ).status,
      403,
    )
    const result = await register('profile')
    assert.equal(
      (await request('/update-user', { name: '新昵称', id: 'someone-else' }, result.cookie)).status,
      200,
    )
    const [updated] = await db.select().from(user).where(eq(user.id, result.id))
    assert.equal(updated.name, '新昵称')
  })

  it('修改密码要求旧密码，并撤销其他会话且旧密码不再有效', async () => {
    const result = await register('password')
    const anotherLogin = await request('/sign-in/email', { email: result.email, password })
    const anotherCookie = cookieOf(anotherLogin)
    const newPassword = 'New-test-password-456!'
    assert.equal(
      (
        await request(
          '/change-password',
          { currentPassword: 'incorrect', newPassword },
          result.cookie,
        )
      ).status,
      400,
    )
    const changed = await request(
      '/change-password',
      { currentPassword: password, newPassword, revokeOtherSessions: false },
      result.cookie,
    )
    assert.equal(changed.status, 200)
    assert.equal(await (await request('/get-session', undefined, anotherCookie)).json(), null)
    const currentCookie = cookieOf(changed)
    assert.ok(currentCookie)
    assert.equal(
      (await (await request('/get-session', undefined, currentCookie)).json()).user.id,
      result.id,
    )
    assert.equal((await request('/sign-in/email', { email: result.email, password })).status, 401)
    assert.equal(
      (await request('/sign-in/email', { email: result.email, password: newPassword })).status,
      200,
    )
  })

  it('Redis 限流存储异常返回 503，读取已有会话和退出不被限流阻断', async () => {
    const original = authRateLimitStorage.consume
    authRateLimitStorage.consume = async () => {
      throw new AuthLimiterUnavailable()
    }
    try {
      const response = await request('/sign-in/email', { email: 'any@example.com', password })
      assert.equal(response.status, 503)
      assert.equal((await response.json()).code, 'LIMITER_UNAVAILABLE')
      assert.equal((await request('/get-session')).status, 200)
      assert.equal((await request('/sign-out', {})).status, 200)
    } finally {
      authRateLimitStorage.consume = original
    }
  })
})
