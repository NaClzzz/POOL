'use client'
import { cn } from '@/lib/utils'

import styles from '@/features/likes/likes-page.module.css'
import sharedStyles from '@/components/presentation.module.css'
import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Download, Sparkles, Link2, CheckCircle2, LoaderCircle } from 'lucide-react'
import { api } from '@/mocks/api'
import { useSession } from '@/stores/session'
import { usePlayer } from '@/stores/player'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Input } from '@/components/ui/input'
import { Empty, ErrorState, Loading } from '@/components/feedback'
import { TrackList } from '@/features/music/track-list'
import { GenerationPanel } from '@/features/ai/generation-panel'
import { PageHeader } from '@/components/page-header'

/** 用户喜欢页面，以完整查询统一驱动列表和容量展示。 */
export function LikesPage() {
  const userId = useSession((s) => s.user!.id)
  const client = useQueryClient()
  const play = usePlayer((s) => s.play)
  const [importOpen, setImportOpen] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [url, setUrl] = useState('')
  const query = useQuery({ queryKey: ['likes', userId], queryFn: () => api.likes() })
  const mutation = useMutation({
    mutationFn: () => api.importLikes(url),
    onSuccess: () => client.invalidateQueries({ queryKey: ['likes', userId] }),
  })
  /** 导入只提交链接，不从页面传递容量或目标用户。 */
  const importPlaylist = (event: FormEvent) => {
    event.preventDefault()
    mutation.mutate()
  }
  return (
    <>
      <PageHeader name="Favorites" title="喜欢">
        <span className={sharedStyles.resultCount}>{query.data?.length ?? 0} / 500 首</span>
      </PageHeader>
      <div className={sharedStyles.pageToolbar}>
        <div className="flex gap-3">
          <Button disabled={!query.data?.length} onClick={() => play(query.data![0], query.data)}>
            <Play className="fill-current" />
            播放全部
          </Button>
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogTrigger render={<Button variant="outline" />} onClick={() => mutation.reset()}>
              <Download />
              导入歌单
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>导入歌单</DialogTitle>
                <DialogDescription>
                  粘贴网易云歌单分享链接，按歌单顺序导入，最多收藏 500 首。
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={importPlaylist}>
                <label className={sharedStyles.field}>
                  歌单链接
                  <div className={sharedStyles.inputWithIcon}>
                    <Link2 className={sharedStyles.inputIcon} size={17} />
                    <Input
                      className={sharedStyles.iconInput}
                      aria-label="网易云歌单链接"
                      placeholder="https://music.163.com/#/playlist?id=…"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      required
                    />
                  </div>
                </label>
                <button
                  className={cn(sharedStyles.sampleLink, sharedStyles.action)}
                  type="button"
                  onClick={() => setUrl('https://music.163.com/#/playlist?id=3778678')}
                >
                  填入演示歌单链接
                </button>
                {mutation.error && (
                  <p className={sharedStyles.inlineError}>{mutation.error.message}</p>
                )}
                {mutation.data && (
                  <div className={styles.importResult}>
                    <CheckCircle2 size={21} />
                    <div>
                      <strong>已新增 {mutation.data.added} 首</strong>
                      <p className={styles.importDetails}>
                        重复 {mutation.data.duplicates} 首 · 超额跳过{' '}
                        {mutation.data.capacitySkipped} 首 · 剩余容量{' '}
                        {mutation.data.remainingCapacity} 首
                      </p>
                    </div>
                  </div>
                )}
                <Button type="submit" className="mt-5 w-full" disabled={mutation.isPending || !url}>
                  {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Download />}
                  开始导入
                </Button>
              </form>
            </DialogContent>
          </Dialog>
          <Sheet open={analysisOpen} onOpenChange={setAnalysisOpen}>
            <SheetTrigger render={<Button variant="ghost" disabled={!query.data?.length} />}>
              <Sparkles />
              歌单分析
            </SheetTrigger>
            <SheetContent aria-describedby={undefined}>
              <SheetHeader>
                <SheetTitle>歌单分析</SheetTitle>
              </SheetHeader>
              <div className={sharedStyles.sheetBody}>
                <GenerationPanel kind="analysis" />
              </div>
            </SheetContent>
          </Sheet>
        </div>
        <span className="text-xs text-muted-foreground">按最近喜欢排序</span>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data.length ? (
        <TrackList tracks={query.data} />
      ) : (
        <Empty title="暂无喜欢的歌曲" />
      )}
    </>
  )
}
