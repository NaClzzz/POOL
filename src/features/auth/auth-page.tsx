'use client'
import { cn } from '@/lib/utils'
import styles from '@/features/auth/auth-page.module.css'
import sharedStyles from '@/components/presentation.module.css'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { authClient, authErrorMessage } from '@/lib/auth-client'
import { authReturnTo } from '@/lib/auth-redirect'
import { useSession } from '@/stores/session'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** 邮箱密码注册／登录表单；密码仅在提交时发送给同域认证入口。 */
type AuthFields = { email: string; password: string; name: string }

/** 登录注册共用的简洁邮箱表单。 */
export function AuthPage({ registerMode = false }: { registerMode?: boolean }) {
  const router = useRouter()
  const params = useSearchParams()
  const user = useSession((s) => s.user)
  const ready = useSession((s) => s.ready)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<AuthFields>({ defaultValues: { email: '', password: '', name: '' } })
  const returnTo = authReturnTo(params.get('returnTo'))
  useEffect(() => {
    if (ready && user) router.replace(returnTo)
  }, [ready, user, returnTo, router])
  /** 表单复用认证库的原生协议，注册与登录使用不同端点。 */
  const submit = async (values: AuthFields) => {
    try {
      const credentials = { email: values.email.trim(), password: values.password }
      const result = registerMode
        ? await authClient.signUp.email({ ...credentials, name: values.name.trim() })
        : await authClient.signIn.email(credentials)
      if (result.error) {
        setError('root', { message: authErrorMessage(result.error) })
        return
      }
      const sessionResult = await authClient.getSession({ query: { disableCookieCache: true } })
      if (sessionResult.error || !sessionResult.data) {
        setError('root', { message: '无法确认登录会话，请重试' })
        return
      }
      router.replace(returnTo)
      router.refresh()
    } catch {
      setError('root', { message: '无法连接账号服务，请稍后重试' })
    }
  }
  return (
    <main className={styles.authPage}>
      <section className={styles.authFormWrap}>
        <div>
          <Link href="/" className={cn(sharedStyles.brand, styles.authBrand, sharedStyles.link)}>
            POOL
          </Link>
          <h1 className={styles.authTitle}>{registerMode ? '注册' : '登录'}</h1>
          <form onSubmit={handleSubmit(submit)} noValidate>
            {registerMode && (
              <label className={sharedStyles.field}>
                昵称
                <Input
                  className={cn(sharedStyles.fieldInput, styles.authInput)}
                  autoComplete="nickname"
                  placeholder="你的昵称"
                  {...register('name', {
                    required: '请输入昵称',
                    maxLength: { value: 30, message: '昵称最多 30 字符' },
                  })}
                />
                {errors.name && (
                  <span className={sharedStyles.fieldError}>{errors.name.message}</span>
                )}
              </label>
            )}
            <label className={sharedStyles.field}>
              邮箱
              <Input
                className={cn(sharedStyles.fieldInput, styles.authInput)}
                autoComplete="email"
                type="email"
                placeholder="you@example.com"
                {...register('email', {
                  required: '请输入邮箱',
                  pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: '请输入有效邮箱' },
                })}
              />
              {errors.email && (
                <span className={sharedStyles.fieldError}>{errors.email.message}</span>
              )}
            </label>
            <label className={sharedStyles.field}>
              密码
              <Input
                className={cn(sharedStyles.fieldInput, styles.authInput)}
                autoComplete={registerMode ? 'new-password' : 'current-password'}
                type="password"
                placeholder="至少 8 位"
                {...register('password', {
                  required: '请输入密码',
                  minLength: { value: 8, message: '密码至少 8 位' },
                  maxLength: { value: 128, message: '密码最多 128 位' },
                })}
              />
              {errors.password && (
                <span className={sharedStyles.fieldError}>{errors.password.message}</span>
              )}
            </label>
            {errors.root && <p className={sharedStyles.inlineError}>{errors.root.message}</p>}
            <Button
              type="submit"
              size="lg"
              className="mt-3 w-full"
              disabled={isSubmitting || !ready}
            >
              {isSubmitting ? <LoaderCircle className="animate-spin" /> : null}
              {registerMode ? '创建账号' : '登录'}
              <ArrowRight />
            </Button>
          </form>
          <p className={styles.authSwitch}>
            {registerMode ? '已有账号？' : '还没有账号？'}
            <Link
              className={cn(styles.authSwitchLink, sharedStyles.link)}
              href={`${registerMode ? '/login' : '/register'}?returnTo=${encodeURIComponent(returnTo)}`}
            >
              {registerMode ? '去登录' : '注册'}
            </Link>
          </p>
        </div>
      </section>
    </main>
  )
}
