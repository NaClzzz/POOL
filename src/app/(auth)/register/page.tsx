import { Suspense } from 'react'
import { AuthPage } from '@/features/auth/auth-page'

/** 提供独立的邮箱密码注册入口。 */
export default function RegisterPage() {
  return (
    <Suspense>
      <AuthPage registerMode />
    </Suspense>
  )
}
