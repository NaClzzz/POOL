'use client'
import { cn } from '@/lib/utils'
import styles from '@/features/music/search-page.module.css'
import sharedStyles from '@/components/presentation.module.css'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Search } from 'lucide-react'
import { useMusicSearch } from './api'
import { HttpError } from '@/lib/http'
import type { MusicSource } from '@/contracts/domain'
import { TrackList } from './track-list'
import { Empty, ErrorState, Loading } from '@/components/feedback'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { Input } from '@/components/ui/input'

/** 搜索路由拥有 URL 查询状态，曲库内容只从统一服务读取。 */
export function SearchPage() {
  const params = useSearchParams()
  const router = useRouter()
  const source: MusicSource = params.get('source') === 'bilibili' ? 'bilibili' : 'netease'
  const q = params.get('q') || ''
  const [input, setInput] = useState(q)
  const query = useMusicSearch(source, q)
  const tracks = query.data?.pages.flatMap((page) => page.items) ?? []
  const total = query.data?.pages[0]?.total
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
          {query.data && (
            <span className={sharedStyles.resultCount}>{total ?? tracks.length} 首</span>
          )}
        </div>
        {!q ? (
          <Empty title="搜索歌曲或作者" />
        ) : query.isPending ? (
          <Loading />
        ) : query.isError ? (
          query.error instanceof HttpError && query.error.code === 'CAPABILITY_NOT_SUPPORTED' ? (
            <Empty title={query.error.message} />
          ) : (
            <ErrorState error={query.error} retry={() => void query.refetch()} />
          )
        ) : tracks.length ? (
          <>
            <TrackList tracks={tracks} />
            {query.hasNextPage && (
              <Button
                className="mt-4"
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? '正在加载…' : '加载更多'}
              </Button>
            )}
            {query.isFetchNextPageError && (
              <p className={sharedStyles.inlineError}>加载下一页失败，可重试。</p>
            )}
          </>
        ) : (
          <Empty title="没有找到这首歌" text="试试另一个关键词，或换个音源看看。" />
        )}
      </section>
    </>
  )
}
