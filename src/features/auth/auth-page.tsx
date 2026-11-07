'use client'
import { cn } from '@/lib/utils'
import styles from '@/features/auth/auth-page.module.css'
import sharedStyles from '@/components/presentation.module.css'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { api } from '@/mocks/api'
import { useSession } from '@/stores/session'
import { DEMO_EMAIL } from '@/mocks/fixtures'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** 演示认证表单，不保存密码，也不冒充真实账号验证。 */
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
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<AuthFields>({ defaultValues: { email: '', password: '', name: '' } })
  const target = params.get('returnTo') || '/search'
  const returnTo = target.startsWith('/') && !target.startsWith('//') ? target : '/search'
  useEffect(() => {
    if (ready && user) router.replace(returnTo)
  }, [ready, user, returnTo, router])
  /** 在表单入口处理模拟服务错误并建立会话。 */
  const submit = async (values: AuthFields) => {
    try {
      const session = await api.login({
        email: values.email,
        password: values.password,
        name: registerMode ? values.name : undefined,
      })
      useSession.getState().setUser(session)
      router.replace(returnTo)
    } catch (error) {
      setError('root', { message: (error as Error).message })
    }
  }
  /** 填入非敏感演示账号，用户仍可查看和修改输入。 */
  const demo = () => {
    setValue('email', DEMO_EMAIL)
    setValue('password', 'pool-demo')
    void handleSubmit(submit)()
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
                })}
              />
              {errors.password && (
                <span className={sharedStyles.fieldError}>{errors.password.message}</span>
              )}
            </label>
            {errors.root && <p className={sharedStyles.inlineError}>{errors.root.message}</p>}
            <Button type="submit" size="lg" className="mt-3 w-full" disabled={isSubmitting}>
              {isSubmitting ? <LoaderCircle className="animate-spin" /> : null}
              {registerMode ? '创建账号' : '登录'}
              <ArrowRight />
            </Button>
          </form>
          {!registerMode && (
            <Button
              variant="outline"
              size="lg"
              className="mt-3 w-full"
              disabled={isSubmitting}
              onClick={demo}
            >
              使用演示账号
            </Button>
          )}
          <p className={styles.authSwitch}>
            {registerMode ? '已有账号？' : '还没有账号？'}
            <Link
              className={cn(styles.authSwitchLink, sharedStyles.link)}
              href={registerMode ? '/login' : '/register'}
            >
              {registerMode ? '去登录' : '注册'}
            </Link>
          </p>
          <p className={styles.authDemoNote}>本地交互原型 · 无需真实账号，密码不会保存</p>
        </div>
      </section>
    </main>
  )
}
