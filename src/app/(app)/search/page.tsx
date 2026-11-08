import { requirePageUser } from '@/server/auth/session'
import { Suspense } from 'react'
import { SearchPage } from '@/features/music/search-page'

/** 允许搜索条件由浏览器 URL 驱动。 */
export default async function SearchRoute() {
  await requirePageUser('/search')
  return (
    <Suspense>
      <SearchPage />
    </Suspense>
  )
}
