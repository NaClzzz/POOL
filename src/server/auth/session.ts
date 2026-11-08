import 'server-only'
import { cache } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from './core'

/** 服务端页面逐次渲染读取真实会话，不将浏览器投影视为授权依据。 */
export const requirePageUser = cache(async (returnTo = '/search') => {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableRefresh: true },
  })
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`)
  return { id: session.user.id, email: session.user.email, name: session.user.name }
})
