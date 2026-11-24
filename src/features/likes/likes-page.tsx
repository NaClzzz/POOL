'use client'
import { cn } from '@/lib/utils'

import sharedStyles from '@/components/presentation.module.css'
import { useState, type FormEvent } from 'react'
import { Play, Download, Link2, LoaderCircle } from 'lucide-react'
import { useLikes, useImportLikes, useClearLikes } from './api'
import { HttpError } from '@/lib/http'
import type { MusicSource } from '@/contracts/domain'
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Empty, ErrorState, Loading } from '@/components/feedback'
import { TrackList } from '@/features/music/track-list'
import { PageHeader } from '@/components/page-header'

/** 用户喜欢页面，以完整查询统一驱动列表和容量展示。 */
export function LikesPage() {
  const play = usePlayer((s) => s.play)
  const [importOpen, setImportOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [source, setSource] = useState<MusicSource>('netease')
  const query = useLikes()
  const importMutation = useImportLikes()
  const clearMutation = useClearLikes({ onSuccess: () => setClearOpen(false) })
  /** 导入只提交选定音源和链接，不从页面传递容量或目标用户。 */
  const importPlaylist = (event: FormEvent) => {
    event.preventDefault()
    importMutation.mutate({ source, url })
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
            <DialogTrigger
              render={<Button variant="outline" />}
              onClick={() => importMutation.reset()}
            >
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
                <div className={sharedStyles.field}>
                  <label htmlFor="playlist-import-source">音源</label>
                  <Select<MusicSource>
                    value={source}
                    onValueChange={(value) => value && setSource(value)}
                    items={[{ value: 'netease', label: '网易云音乐' }]}
                    disabled={importMutation.isPending}
                  >
                    <SelectTrigger
                      id="playlist-import-source"
                      className="w-full"
                      aria-label="导入音源"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectItem value="netease">网易云音乐</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
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
                  onClick={() =>
                    setUrl(
                      'https://music.163.com/playlist?id=817675326&uct2=U2FsdGVkX1/x6bOmCDNpq+JTx0yDCJS1dkLYt0GGdWI=',
                    )
                  }
                >
                  导入作者的歌单 ( ? )
                </button>
                {importMutation.error instanceof HttpError &&
                  ['INVALID_INPUT', 'INVALID_PLAYLIST_LINK'].includes(
                    importMutation.error.code,
                  ) && <p className={sharedStyles.inlineError}>{importMutation.error.message}</p>}
                <Button
                  type="submit"
                  className="mt-5 w-full"
                  disabled={importMutation.isPending || !url}
                >
                  {importMutation.isPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Download />
                  )}
                  开始导入
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
        <AlertDialog
          open={clearOpen}
          onOpenChange={(open) => {
            if (!clearMutation.isPending) setClearOpen(open)
          }}
        >
          <AlertDialogTrigger
            render={
              <Button
                variant="link"
                className="h-auto p-0 text-xs text-muted-foreground hover:no-underline"
                disabled={
                  !query.data?.length || importMutation.isPending || clearMutation.isPending
                }
              />
            }
            onClick={() => clearMutation.reset()}
          >
            清空喜欢
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>清空喜欢列表？</AlertDialogTitle>
              <AlertDialogDescription>
                将清空全部 {query.data?.length ?? 0} 首喜欢，无法撤销。正在播放的队列会保留。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={clearMutation.isPending}>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={clearMutation.isPending}
                onClick={() => clearMutation.mutate()}
              >
                {clearMutation.isPending ? '正在清空…' : '确认清空'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
