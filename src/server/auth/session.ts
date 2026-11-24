import 'server-only'
import { cache } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from './core'

/** 页面鉴权 */
export const requirePageUser = cache(async (returnTo = '/search') => {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableRefresh: true },
  })
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`)
  return { id: session.user.id, email: session.user.email, name: session.user.name }
})
