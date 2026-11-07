'use client'
import { cn } from '@/lib/utils'

import styles from '@/features/room/lobby-page.module.css'
import sharedStyles from '@/components/presentation.module.css'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Clock3, LockKeyhole, Plus, Search, Users } from 'lucide-react'
import { api } from '@/mocks/api'
import { useSession } from '@/stores/session'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, ErrorState, Loading } from '@/components/feedback'
import { PageHeader } from '@/components/page-header'

/** 大厅创建表单只提交业务字段，不接受客户端提供的所有者。 */
type CreateFields = {
  name: string
  tag: string
  maxMembers: number
  maxStageMembers: number
  protected: boolean
}

/** 房间大厅与创建入口，列表查询不维护实时房间快照。 */
export function LobbyPage() {
  const [q, setQ] = useState('')
  const [input, setInput] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const router = useRouter()
  const client = useQueryClient()
  const user = useSession((s) => s.user!)
  const query = useQuery({ queryKey: ['rooms', q], queryFn: () => api.rooms(q) })
  const form = useForm<CreateFields>({
    defaultValues: {
      name: '',
      tag: '松弛一下',
      maxMembers: 12,
      maxStageMembers: 4,
      protected: false,
    },
  })
  const create = useMutation({
    mutationFn: api.createRoom,
    onSuccess: (room) => {
      void client.invalidateQueries({ queryKey: ['rooms'] })
      setCreateOpen(false)
      router.push(`/rooms/${room.roomCode}`)
    },
  })
  /** 提交已确认的查询条件，避免输入每个字符都模拟一次请求。 */
  const search = (e: FormEvent) => {
    e.preventDefault()
    setQ(input)
  }
  return (
    <>
      <PageHeader name="Listen Together" title="一起听">
        <Button variant="outline" render={<Link href="/rooms/history" />} nativeButton={false}>
          <Clock3 />
          房间历史
        </Button>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger render={<Button />} onClick={() => create.reset()}>
            <Plus />
            创建房间
          </DialogTrigger>
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>创建房间</DialogTitle>
            </DialogHeader>
            <form onSubmit={form.handleSubmit((values) => create.mutate(values))}>
              <label className={sharedStyles.field}>
                房间名称
                <Input
                  className={sharedStyles.fieldInput}
                  placeholder="输入房间名称"
                  {...form.register('name', { required: true, minLength: 2, maxLength: 20 })}
                />
              </label>
              <label className={sharedStyles.field}>
                房间标签
                <Input
                  className={sharedStyles.fieldInput}
                  {...form.register('tag', { required: true, minLength: 2, maxLength: 12 })}
                />
              </label>
              <div className={sharedStyles.formColumns}>
                <label className={sharedStyles.field}>
                  房间人数
                  <Input
                    className={sharedStyles.fieldInput}
                    type="number"
                    min={2}
                    max={50}
                    {...form.register('maxMembers', { valueAsNumber: true, min: 2, max: 50 })}
                  />
                </label>
                <label className={sharedStyles.field}>
                  上台人数
                  <Input
                    className={sharedStyles.fieldInput}
                    type="number"
                    min={1}
                    max={30}
                    {...form.register('maxStageMembers', { valueAsNumber: true, min: 1, max: 30 })}
                  />
                </label>
              </div>
              <label className={sharedStyles.checkboxField}>
                <Controller
                  name="protected"
                  control={form.control}
                  render={({ field }) => (
                    <Checkbox
                      name={field.name}
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      onBlur={field.onBlur}
                      ref={field.ref}
                    />
                  )}
                />
                设置为密码房
              </label>
              {form.watch('protected') && (
                <p className={sharedStyles.formNote}>演示密码统一为 pool2026，不保存输入密码。</p>
              )}
              {Object.keys(form.formState.errors).length > 0 && (
                <p className={sharedStyles.inlineError}>请检查名称、标签和人数设置。</p>
              )}
              {create.error && <p className={sharedStyles.inlineError}>{create.error.message}</p>}
              <Button type="submit" className="mt-5 w-full" disabled={create.isPending}>
                <Plus />
                {create.isPending ? '正在创建…' : '创建并进入'}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </PageHeader>
      <div className={sharedStyles.pageToolbar}>
        <div className={styles.roomFilters}>
          {['全部房间', '松弛一下', '深夜电台', '一起发呆'].map((tag) => (
            <button
              key={tag}
              className={cn(
                cn(styles.filterButton, (tag === '全部房间' ? !q : q === tag) && styles.active),
                sharedStyles.action,
              )}
              onClick={() => {
                setQ(tag === '全部房间' ? '' : tag)
                setInput('')
              }}
            >
              {tag}
            </button>
          ))}
        </div>
        <form className={sharedStyles.smallSearch} onSubmit={search}>
          <Search size={16} />
          <Input
            variant="embedded"
            density="compact"
            aria-label="搜索房间"
            placeholder="搜索房间名或房间号"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </form>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.length ? (
        <Empty title="暂无匹配房间" />
      ) : (
        <div className={styles.roomGrid}>
          {query.data.map((room) => (
            <Link
              className={cn(styles.roomCard, sharedStyles.link)}
              href={`/rooms/${room.roomCode}`}
              key={room.roomId}
            >
              <div className={styles.roomCardHeading}>
                <span className={styles.roomTag}>{room.tag}</span>
                <span className={styles.roomOnline}>{room.memberCount} 人在听</span>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h2 className={styles.roomTitle}>{room.name}</h2>
                  {room.isPasswordProtected ? (
                    <LockKeyhole size={15} className="text-muted-foreground" />
                  ) : (
                    <ArrowUpRight size={18} className="text-primary" />
                  )}
                </div>
                <div className={styles.roomCardMeta}>
                  <span className={styles.roomMetaItem}>
                    <span className={styles.miniAvatar}>{room.ownerName.slice(0, 1)}</span>
                    {room.createdBy === user.id ? '我的房间' : room.ownerName}
                  </span>
                  <span className={styles.roomMetaItem}>
                    <Users size={14} />
                    {room.memberCount} / {room.maxMembers}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
