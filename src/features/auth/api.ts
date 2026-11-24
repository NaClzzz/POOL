import { useMutation } from '@tanstack/react-query'
import { useSession } from '@/stores/session'
import { authClient, authErrorMessage } from '@/lib/auth-client'
import { HttpError, type MutationSuccessOptions } from '@/lib/http'
import { notifyError, notifySuccess } from '@/lib/notifications'

/** 账号修改只提交当前操作需要的字段，密码不进入持久状态。 */
type AccountUpdate =
  | { mode: 'name'; name: string }
  | { mode: 'password'; currentPassword: string; newPassword: string }

/** 账号输入错误留在表单，限流、网络和服务错误使用操作通知。 */
export function isAccountFormError(error: unknown): error is HttpError {
  return (
    error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429
  )
}

/** 登录与注册输入只用于本次请求，不写入持久状态。 */
type AuthInput = { email: string; password: string; name: string }

/** 账号建立会话后通知结果，页面只处理表单与导航。 */
export function useAuthenticate(
  registerMode: boolean,
  options: MutationSuccessOptions<void, AuthInput> = {},
) {
  return useMutation({
    mutationFn: async (input: AuthInput) => {
      try {
        const credentials = { email: input.email.trim(), password: input.password }
        const result = registerMode
          ? await authClient.signUp.email({ ...credentials, name: input.name.trim() })
          : await authClient.signIn.email(credentials)
        if (result.error)
          throw new HttpError(
            result.error.code ?? 'AUTH_ERROR',
            authErrorMessage(result.error),
            result.error.status ?? 0,
            null,
          )
        const session = await authClient.getSession({ query: { disableCookieCache: true } })
        if (session.error || !session.data)
          throw new HttpError('SESSION_UNAVAILABLE', '无法确认登录会话，请重试', 503, null)
      } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError('NETWORK_ERROR', '无法连接账号服务，请稍后重试', 0, null)
      }
    },
    onSuccess: async (data, input) => {
      notifySuccess(registerMode ? '账号已创建' : '已登录')
      await options.onSuccess?.(data, input)
    },
    onError: (error) => {
      if (!isAccountFormError(error)) notifyError(error)
    },
  })
}

/** 复用认证库更新资料；校验错误交给表单，其余操作结果统一通知。 */
export function useUpdateAccount(options: MutationSuccessOptions<void, AccountUpdate> = {}) {
  return useMutation({
    onMutate: () => useSession.getState().user?.id,
    mutationFn: async (input: AccountUpdate) => {
      try {
        const result =
          input.mode === 'name'
            ? await authClient.updateUser({ name: input.name })
            : await authClient.changePassword({
                currentPassword: input.currentPassword,
                newPassword: input.newPassword,
                revokeOtherSessions: true,
              })
        if (result.error)
          throw new HttpError(
            result.error.code ?? 'AUTH_ERROR',
            authErrorMessage(result.error),
            result.error.status ?? 0,
            null,
          )
        await authClient.getSession({ query: { disableCookieCache: true } })
      } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError('NETWORK_ERROR', '无法连接账号服务，请稍后重试', 0, null)
      }
    },
    onSuccess: async (data, input, userId) => {
      if (userId !== useSession.getState().user?.id) return
      notifySuccess(input.mode === 'name' ? '昵称已更新' : '密码已更新，其他登录会话已退出')
      await options.onSuccess?.(data, input)
    },
    onError: (error, _input, userId) => {
      if (isAccountFormError(error)) return
      if (userId === useSession.getState().user?.id) notifyError(error)
    },
  })
}
