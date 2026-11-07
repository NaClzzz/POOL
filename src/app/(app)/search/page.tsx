import { Suspense } from 'react'
import { SearchPage } from '@/features/music/search-page'

/** 允许搜索条件由浏览器 URL 驱动。 */
export default function SearchRoute() {
  return (
    <Suspense>
      <SearchPage />
    </Suspense>
  )
}
