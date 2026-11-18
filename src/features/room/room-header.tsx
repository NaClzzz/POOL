'use client'
import { useState } from 'react'
import { Crown, LogOut, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
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
import { useSession } from '@/stores/session'
import type { RoomSettings, RoomSnapshot } from '@/contracts/room'
import type { RoomCommand } from './types'
import styles from './room-page.module.css'
import shared from '@/components/presentation.module.css'
import { cn } from '@/lib/utils'

/** 房主表单独立维护草稿，打开时以最新快照初始化。 */
export function RoomHeader({
  snapshot,
  connected,
  command,
  leave,
}: {
  snapshot: RoomSnapshot
  connected: boolean
  command: RoomCommand
  leave: () => void
}) {
  const userId = useSession((s) => s.user!.id)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [settings, setSettings] = useState<RoomSettings>({
    name: '',
    tag: '',
    maxMembers: 10,
    maxStageMembers: 10,
    passwordAction: 'keep',
  })
  const [error, setError] = useState('')
  /** 只提交当前表单，成功确认后关闭。 */
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (settings.maxStageMembers > settings.maxMembers) {
      setError('上台人数不能超过房间人数')
      return
    }
    setPending(true)
    if (await command('room:update-settings', settings, (failure) => setError(failure.message)))
      setOpen(false)
    setPending(false)
  }
  return (
    <header className={styles.roomHeader}>
      <div>
        <div className="flex items-center gap-3">
          <h1 className={styles.roomTitle}>{snapshot.room.name}</h1>
          <span className={shared.softTag}>{snapshot.room.tag}</span>
        </div>
        <p className={styles.roomMeta}>
          <span className={shared.liveDot} />
          {snapshot.members.length} 人在听<span className="mx-2">·</span>
          {snapshot.room.roomCode}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {snapshot.room.ownerId === userId && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
              render={<Button variant="outline" size="sm" disabled={!connected} />}
              onClick={() => {
                setSettings({
                  name: snapshot.room.name,
                  tag: snapshot.room.tag,
                  maxMembers: snapshot.room.maxMembers,
                  maxStageMembers: snapshot.room.maxStageMembers,
                  passwordAction: 'keep',
                })
                setError('')
              }}
            >
              <Settings2 />
              房间设置
            </DialogTrigger>
            <DialogContent aria-describedby={undefined}>
              <DialogHeader>
                <DialogTitle>房间设置</DialogTitle>
              </DialogHeader>
              <form onSubmit={(e) => void save(e)}>
                <label className={shared.field}>
                  房间名称
                  <Input
                    value={settings.name}
                    minLength={2}
                    maxLength={20}
                    required
                    onChange={(e) => setSettings({ ...settings, name: e.target.value })}
                  />
                </label>
                <label className={shared.field}>
                  房间标签
                  <Input
                    value={settings.tag}
                    minLength={2}
                    maxLength={12}
                    required
                    onChange={(e) => setSettings({ ...settings, tag: e.target.value })}
                  />
                </label>
                <div className={shared.formColumns}>
                  <label className={shared.field}>
                    房间人数
                    <Input
                      type="number"
                      min={snapshot.members.length > 2 ? snapshot.members.length : 2}
                      max={50}
                      value={settings.maxMembers}
                      onChange={(e) =>
                        setSettings({ ...settings, maxMembers: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label className={shared.field}>
                    上台人数
                    <Input
                      type="number"
                      min={snapshot.stageIds.length || 1}
                      max={30}
                      value={settings.maxStageMembers}
                      onChange={(e) =>
                        setSettings({ ...settings, maxStageMembers: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
                <div className={shared.field}>
                  <span>房间密码</span>
                  <div
                    className={styles.passwordOptions}
                    role="radiogroup"
                    aria-label="房间密码操作"
                  >
                    {(
                      [
                        ['keep', '保持不变'],
                        ['set', '设置新密码'],
                        ['remove', '移除密码'],
                      ] as const
                    ).map(([value, label]) => (
                      <Button
                        key={value}
                        type="button"
                        variant="ghost"
                        size="sm"
                        role="radio"
                        aria-checked={settings.passwordAction === value}
                        className={cn(
                          styles.passwordOption,
                          settings.passwordAction === value && styles.passwordOptionActive,
                        )}
                        onClick={() => setSettings({ ...settings, passwordAction: value })}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>
                {settings.passwordAction === 'set' && (
                  <Input
                    type="password"
                    aria-label="新房间密码"
                    minLength={6}
                    maxLength={64}
                    required
                    autoComplete="new-password"
                    value={settings.password ?? ''}
                    onChange={(e) => setSettings({ ...settings, password: e.target.value })}
                  />
                )}
                {error && <p className={shared.inlineError}>{error}</p>}
                <Button type="submit" className="mt-4 w-full" disabled={pending || !connected}>
                  保存设置
                </Button>
              </form>
              <section className={styles.memberManagement}>
                <h3 className={styles.managementTitle}>成员管理</h3>
                {snapshot.members.map((member) => (
                  <div key={member.userId} className={styles.memberManagementRow}>
                    <span>{member.name}</span>
                    {member.isOwner && <Crown size={12} />}
                    {member.userId !== userId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!connected}
                        onClick={() =>
                          void command('room:kick-member', { targetUserId: member.userId })
                        }
                      >
                        移出
                      </Button>
                    )}
                  </div>
                ))}
              </section>
              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="destructive" disabled={!connected} />}>
                  解散房间
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>结束并解散房间？</AlertDialogTitle>
                    <AlertDialogDescription>
                      房间结束后保留 7 天历史，个人房间歌单不受影响。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => void command('room:dissolve', {})}
                    >
                      解散
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </DialogContent>
          </Dialog>
        )}
        <Button variant="outline" size="sm" onClick={leave}>
          <LogOut />
          离开
        </Button>
      </div>
    </header>
  )
}
