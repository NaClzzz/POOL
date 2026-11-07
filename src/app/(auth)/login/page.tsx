import { Suspense } from 'react'
import { AuthPage } from '@/features/auth/auth-page'

/** 为登录查询参数提供静态渲染边界。 */
export default function LoginPage() {
  return (
    <Suspense>
      <AuthPage />
    </Suspense>
  )
}
