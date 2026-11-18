import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userId: 'a',
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
  getSession: vi.fn(),
  updateUser: vi.fn(),
  changePassword: vi.fn(),
}))
vi.mock('@/lib/notifications', () => ({
  notifySuccess: mocks.notifySuccess,
  notifyError: mocks.notifyError,
}))
vi.mock('@/stores/session', () => ({
  useSession: { getState: () => ({ user: { id: mocks.userId } }) },
}))
vi.mock('@/lib/auth-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth-client')>()),
  authClient: {
    signIn: { email: mocks.signIn },
    signUp: { email: mocks.signUp },
    getSession: mocks.getSession,
    updateUser: mocks.updateUser,
    changePassword: mocks.changePassword,
  },
}))
import { isAccountFormError, useAuthenticate, useUpdateAccount } from '@/lib/api-client'

let client: QueryClient

/** 使用真实 mutation 生命周期验证认证反馈，不连接账号服务。 */
function renderHook<T>(hook: () => T): T {
  let result!: T
  /** 捕获业务 hook 的公开操作。 */
  function Probe() {
    result = hook()
    return null
  }
  renderToString(createElement(QueryClientProvider, { client }, createElement(Probe)))
  return result
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.userId = 'a'
  mocks.signIn.mockResolvedValue({ error: null })
  mocks.signUp.mockResolvedValue({ error: null })
  mocks.getSession.mockResolvedValue({ data: { user: { id: 'a' } }, error: null })
  mocks.updateUser.mockResolvedValue({ error: null })
  mocks.changePassword.mockResolvedValue({ error: null })
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
})

afterEach(() => client.clear())

describe('账号操作反馈', () => {
  it('注册确认会话后仅通知一次，由页面回调完成导航', async () => {
    const navigate = vi.fn()
    await renderHook(() => useAuthenticate(true, { onSuccess: navigate })).mutateAsync({
      email: ' a@example.com ',
      password: 'password',
      name: ' A ',
    })
    expect(mocks.signUp).toHaveBeenCalledWith({
      email: 'a@example.com',
      password: 'password',
      name: 'A',
    })
    expect(mocks.getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } })
    expect(mocks.notifySuccess).toHaveBeenCalledExactlyOnceWith('账号已创建')
    expect(navigate).toHaveBeenCalledOnce()
  })
  it('邮箱密码错误保留为表单错误，不重复通知', async () => {
    mocks.signIn.mockResolvedValue({ error: { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 } })
    const error = await renderHook(() => useAuthenticate(false))
      .mutateAsync({
        email: 'a@example.com',
        password: 'bad',
        name: '',
      })
      .catch((failure: unknown) => failure)
    expect(isAccountFormError(error)).toBe(true)
    expect(mocks.notifyError).not.toHaveBeenCalled()
    expect(mocks.notifySuccess).not.toHaveBeenCalled()
  })
  it('登录网络失败使用一次通知，不标记为表单校验', async () => {
    mocks.signIn.mockRejectedValue(new TypeError('network'))
    const error = await renderHook(() => useAuthenticate(false))
      .mutateAsync({
        email: 'a@example.com',
        password: 'password',
        name: '',
      })
      .catch((failure: unknown) => failure)
    expect(isAccountFormError(error)).toBe(false)
    expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(error)
  })
  it('密码更新保留撤销其他会话与刷新会话行为', async () => {
    await renderHook(() => useUpdateAccount()).mutateAsync({
      mode: 'password',
      currentPassword: 'old',
      newPassword: 'new-password',
    })
    expect(mocks.changePassword).toHaveBeenCalledWith({
      currentPassword: 'old',
      newPassword: 'new-password',
      revokeOtherSessions: true,
    })
    expect(mocks.notifySuccess).toHaveBeenCalledExactlyOnceWith('密码已更新，其他登录会话已退出')
  })
  it('旧密码错误留在表单，服务失败使用通知', async () => {
    mocks.changePassword.mockResolvedValueOnce({ error: { code: 'INVALID_PASSWORD', status: 400 } })
    const input = { mode: 'password' as const, currentPassword: 'bad', newPassword: 'new-password' }
    await expect(renderHook(() => useUpdateAccount()).mutateAsync(input)).rejects.toThrow(
      '当前密码不正确',
    )
    expect(mocks.notifyError).not.toHaveBeenCalled()
    mocks.changePassword.mockResolvedValueOnce({ error: { status: 503 } })
    await expect(renderHook(() => useUpdateAccount()).mutateAsync(input)).rejects.toThrow(
      '账号服务暂时不可用',
    )
    expect(mocks.notifyError).toHaveBeenCalledOnce()
  })
})
