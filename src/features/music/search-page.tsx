'use client'
import { cn } from '@/lib/utils'
import styles from '@/features/music/search-page.module.css'
import sharedStyles from '@/components/presentation.module.css'
import { useQuery } from '@tanstack/react-query'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Search } from 'lucide-react'
import { api } from '@/mocks/api'
import { TrackList } from './track-list'
import { Empty, ErrorState, Loading } from '@/components/feedback'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { Input } from '@/components/ui/input'

/** 搜索路由拥有 URL 查询状态，曲库内容只从统一服务读取。 */
export function SearchPage() {
  const params = useSearchParams()
  const router = useRouter()
  const source = params.get('source') === 'bilibili' ? 'bilibili' : 'netease'
  const q = params.get('q') || ''
  const [input, setInput] = useState(q)
  const query = useQuery({
    queryKey: ['music', 'search', source, q],
    queryFn: ({ signal }) => api.search(source, q, signal),
  })
  /** 将提交过的搜索条件写进 URL，输入中不请求服务。 */
  const search = (event: FormEvent) => {
    event.preventDefault()
    router.push(`/search?source=${source}&q=${encodeURIComponent(input.trim())}`)
  }
  return (
    <>
      <PageHeader name="Search" title="搜索" />
      <section className={styles.searchControls}>
        <form className={styles.searchBox} onSubmit={search}>
          <Search size={20} />
          <Input
            variant="embedded"
            className={styles.searchInput}
            aria-label="搜索歌曲或作者"
            placeholder="搜索歌曲或作者"
            value={input}
            maxLength={80}
            onChange={(e) => setInput(e.target.value)}
          />
          <Button className={styles.searchButton} type="submit">
            搜索
          </Button>
        </form>
        <div className={styles.sourcePills} aria-label="选择音源">
          <button
            className={cn(
              cn(styles.sourcePill, source === 'netease' && styles.selected),
              sharedStyles.action,
            )}
            onClick={() => router.push(`/search?source=netease&q=${encodeURIComponent(q)}`)}
          >
            网易云音乐
          </button>
          <button
            className={cn(
              cn(styles.sourcePill, source === 'bilibili' && styles.selected),
              sharedStyles.action,
            )}
            onClick={() => router.push(`/search?source=bilibili&q=${encodeURIComponent(q)}`)}
          >
            Bilibili
          </button>
        </div>
      </section>
      <section>
        <div className={styles.sectionTitle}>
          <h2 className={styles.sectionHeading}>{q ? `“${q}” 的搜索结果` : '歌曲'}</h2>
          {query.data && <span className={sharedStyles.resultCount}>{query.data.length} 首</span>}
        </div>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : query.data.length ? (
          <TrackList tracks={query.data} />
        ) : (
          <Empty title="没有找到这首歌" text="试试另一个关键词，或换个音源看看。" />
        )}
      </section>
    </>
  )
}
