'use client'
import playerStyles from '@/features/player/player-dock.module.css'
import styles from '@/features/room/room-page.module.css'
import sharedStyles from '@/components/presentation.module.css'
import { cn } from '@/lib/utils'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Crown,
  DoorOpen,
  Headphones,
  ListMusic,
  LogOut,
  Send,
  Settings2,
  SkipForward,
  Volume2,
} from 'lucide-react'
import { api } from '@/mocks/api'
import { likesApi } from '@/lib/api-client'
import { MockRoomSession } from '@/mocks/room-session'
import { DEMO_ROOM_PASSWORD } from '@/mocks/fixtures'
import type { RoomSnapshot, Track } from '@/contracts/domain'
import { useSession } from '@/stores/session'
import { usePlayer } from '@/stores/player'
import { useRoomAudio } from '@/features/player/audio'
import { RoomPlaylistSheet } from './room-playlist-sheet'
import { formatTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Sheet, SheetTrigger } from '@/components/ui/sheet'
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
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Avatar, AvatarFallback, AvatarGroup } from '@/components/ui/avatar'
import { Slider } from '@/components/ui/slider'

import { Loading, ErrorState } from '@/components/feedback'

/** 房间专用播放器读取锚点，进度只读且不广播逐秒更新。 */
function RoomDock({
  snapshot,
  onSkip,
  unlock,
  error,
}: {
  snapshot: RoomSnapshot
  onSkip: () => void
  unlock: () => void
  error: string
}) {
  const userId = useSession((s) => s.user!.id)
  const volume = usePlayer((s) => s.volume)
  const setVolume = usePlayer((s) => s.setVolume)
  const [now, setNow] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  const { playback, members } = snapshot
  const duration = playback.track?.duration_ms ?? 24_000
  const elapsed = Math.max(0, Math.min(duration, (now || playback.startedAt) - playback.startedAt))
  const mine = playback.activeMemberId === userId
  return (
    <footer className={playerStyles.playerDock}>
      <div className={playerStyles.playerDockInner}>
        <div className={playerStyles.dockTrack}>
          {playback.track ? (
            <img className={playerStyles.dockCover} alt="" src={playback.track.cover_url!} />
          ) : (
            <div className={cn(playerStyles.dockCover, playerStyles.emptyCover)}>
              <Headphones />
            </div>
          )}
          <div className="min-w-0">
            <p className={cn(playerStyles.trackTitle, 'truncate font-medium')}>
              {playback.track?.title ?? '等待播放'}
            </p>
            <p className={cn(playerStyles.trackAuthor, 'mt-1 text-xs text-muted-foreground')}>
              {playback.track?.author ?? '上台后自动轮播'}
              <span className="ml-2 text-primary">一起听</span>
            </p>
          </div>
        </div>
        <div className={playerStyles.roomDockCenter}>
          {error ? (
            <button
              className={cn(
                cn(playerStyles.audioUnlock, playerStyles.roomPlaybackButton),
                sharedStyles.action,
              )}
              onClick={unlock}
            >
              <Volume2 size={15} />
              启用声音
            </button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={
                !playback.track ||
                snapshot.connection !== 'joined' ||
                playback.votes.includes(userId)
              }
              className={playerStyles.roomPlaybackButton}
              onClick={onSkip}
            >
              <SkipForward />
              {mine
                ? '切歌'
                : `投票切歌 ${playback.votes.length}/${Math.max(1, members.length - 1)}`}
            </Button>
          )}
          <div className={cn(playerStyles.progressRow, playerStyles.roomProgress)}>
            <span>{formatTime(elapsed)}</span>
            <div
              className={playerStyles.readonlyProgress}
              role="progressbar"
              aria-label="房间播放进度，只读"
              aria-valuenow={Math.round((elapsed / duration) * 100)}
            >
              <span
                className={playerStyles.progressFill}
                style={{ width: `${(elapsed / duration) * 100}%` }}
              />
            </div>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
        <div className={playerStyles.dockTools}>
          <Volume2 className={playerStyles.volumeIcon} size={17} />
          <Slider
            className={playerStyles.volumeSlider}
            aria-label="房间音量"
            min={0}
            max={1}
            step={0.01}
            value={[volume]}
            onValueChange={(value) => setVolume((value as number[])[0])}
          />
          <span className={playerStyles.dockDivider} />
          <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="我的房间歌单" />}>
            <ListMusic className={playerStyles.queueIcon} />
          </SheetTrigger>
        </div>
      </div>
    </footer>
  )
}

/** 页面内的房间会话；切换路由时明确销毁模拟连接和音频。 */
export function RoomPage({ code }: { code: string }) {
  const user = useSession((s) => s.user!)
  const router = useRouter()
  const client = useQueryClient()
  const session = useRef<MockRoomSession | null>(null)
  const alive = useRef(true)
  const unsubscribe = useRef<(() => void) | null>(null)
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [joinError, setJoinError] = useState<Error | null>(null)
  const [password, setPassword] = useState('')
  const [joining, setJoining] = useState(true)
  const [queueOpen, setQueueOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dissolveOpen, setDissolveOpen] = useState(false)
  const [roomName, setRoomName] = useState('')
  const [tag, setTag] = useState('')
  const [capacity, setCapacity] = useState(12)
  const [stageCapacity, setStageCapacity] = useState(4)
  const [protectedRoom, setProtectedRoom] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const chatMessages = useRef<HTMLDivElement>(null)
  const roomAudioRef = useRef<HTMLAudioElement>(null)
  /** 异步加入完成前检查页面仍在，防止离页后建立幽灵会话。 */
  const join = useCallback(
    async (secret: string) => {
      try {
        const room = await api.joinRoom(code, secret)
        if (!alive.current) return
        session.current?.dispose()
        unsubscribe.current?.()
        session.current = new MockRoomSession(room)
        unsubscribe.current = session.current.subscribe(setSnapshot)
        usePlayer.getState().setRoom(true)
        void client.invalidateQueries({ queryKey: ['room-history'] })
      } catch (failure) {
        if (alive.current) setJoinError(failure as Error)
      } finally {
        if (alive.current) setJoining(false)
      }
    },
    [code, client],
  )
  useEffect(() => {
    alive.current = true
    void join('')
    return () => {
      alive.current = false
      unsubscribe.current?.()
      session.current?.dispose()
      session.current = null
      usePlayer.getState().setRoom(false)
      void client.invalidateQueries({ queryKey: ['rooms'] })
    }
  }, [join, client])
  useEffect(() => {
    const container = chatMessages.current
    container?.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
  }, [snapshot?.messages.length])
  const mediaError = useCallback((version: number) => session.current?.mediaError(version), [])
  const {
    error: audioError,
    unlock: unlockAudio,
    mediaError: handleMediaError,
  } = useRoomAudio(snapshot?.playback, snapshot?.connection === 'joined', mediaError, roomAudioRef)
  /** 手动重试仅在用户交互中进入加载态。 */
  const beginJoin = (secret: string) => {
    setJoining(true)
    setJoinError(null)
    void join(secret)
  }
  /** 在用户动作边界显示统一命令错误，业务组件不重复捕获。 */
  const command = (action: (service: MockRoomSession) => void) => {
    try {
      action(session.current!)
      setError('')
    } catch (failure) {
      setError((failure as Error).message)
    }
  }
  /** 发送成功才清空草稿，错误时保留输入。 */
  const send = (event: FormEvent) => {
    event.preventDefault()
    command((service) => {
      service.send(message)
      setMessage('')
    })
  }
  /** 个人房间歌单的添加行为不改变个人播放器队列。 */
  const add = (track: Track) => command((service) => service.addTrack(track))
  /** 房间仍为模拟服务，但导入喜欢读取真实 PostgreSQL 收藏。 */
  const playlistAction = async (action: 'clear' | 'shuffle' | 'import') => {
    if (action !== 'import') {
      command((service) => service.playlistAction(action))
      return
    }
    const current = session.current
    try {
      const tracks = await likesApi.list()
      if (session.current === current)
        command((service) => service.playlistAction('import', tracks))
    } catch (failure) {
      if (alive.current) setError((failure as Error).message)
    }
  }
  if (!snapshot)
    return (
      <div className={styles.joinPage}>
        <Button variant="outline" size="sm" onClick={() => router.push('/rooms')}>
          <LogOut />
          离开
        </Button>
        {joining ? (
          <Loading />
        ) : joinError?.message.includes('密码') ? (
          <div className={styles.passwordCard}>
            <h1 className={styles.passwordTitle}>这是一个密码房间</h1>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                beginJoin(password)
              }}
            >
              <Input
                aria-label="房间密码"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入房间密码"
                autoComplete="off"
              />
              <p className={sharedStyles.formNote}>演示房间密码：{DEMO_ROOM_PASSWORD}</p>
              <Button type="submit" className="w-full" disabled={joining}>
                进入房间
                <DoorOpen />
              </Button>
            </form>
            <p className={sharedStyles.inlineError}>{password ? joinError.message : ''}</p>
          </div>
        ) : (
          <ErrorState error={joinError} retry={() => beginJoin(password)} />
        )}
      </div>
    )
  const mine = snapshot.room.ownerId === user.id
  const onStage = snapshot.stageIds.includes(user.id)
  return (
    <Sheet open={queueOpen} onOpenChange={setQueueOpen}>
      <div className={styles.roomPage}>
        <audio ref={roomAudioRef} onError={handleMediaError} preload="metadata" />
        <header className={styles.roomHeader}>
          <div className="flex items-center gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className={styles.roomTitle}>{snapshot.room.name}</h1>
                <span className={sharedStyles.softTag}>{snapshot.room.tag}</span>
              </div>
              <p className={styles.roomMeta}>
                <span className={sharedStyles.liveDot} />
                {snapshot.members.length} 人在听<span className="mx-2">·</span>
                {snapshot.room.roomCode}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {mine && (
              <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
                <DialogTrigger
                  render={<Button variant="outline" size="sm" />}
                  onClick={() => {
                    setRoomName(snapshot.room.name)
                    setTag(snapshot.room.tag)
                    setCapacity(snapshot.room.maxMembers)
                    setStageCapacity(snapshot.room.maxStageMembers)
                    setProtectedRoom(snapshot.room.isPasswordProtected)
                  }}
                >
                  <Settings2 />
                  房间设置
                </DialogTrigger>
                <DialogContent aria-describedby={undefined}>
                  <DialogHeader>
                    <DialogTitle>房间设置</DialogTitle>
                  </DialogHeader>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      command((s) => {
                        s.settings({
                          name: roomName,
                          tag,
                          maxMembers: capacity,
                          maxStageMembers: stageCapacity,
                          isPasswordProtected: protectedRoom,
                        })
                        setSettingsOpen(false)
                      })
                    }}
                  >
                    <label className={sharedStyles.field}>
                      房间名称
                      <Input
                        className={sharedStyles.fieldInput}
                        value={roomName}
                        onChange={(e) => setRoomName(e.target.value)}
                        minLength={2}
                        maxLength={20}
                        required
                      />
                    </label>
                    <label className={sharedStyles.field}>
                      标签
                      <Input
                        className={sharedStyles.fieldInput}
                        value={tag}
                        onChange={(e) => setTag(e.target.value)}
                        minLength={2}
                        maxLength={12}
                        required
                      />
                    </label>
                    <div className={sharedStyles.formColumns}>
                      <label className={sharedStyles.field}>
                        房间人数
                        <Input
                          className={sharedStyles.fieldInput}
                          type="number"
                          value={capacity}
                          min={2}
                          max={50}
                          onChange={(e) => setCapacity(Number(e.target.value))}
                        />
                      </label>
                      <label className={sharedStyles.field}>
                        上台人数
                        <Input
                          className={sharedStyles.fieldInput}
                          type="number"
                          value={stageCapacity}
                          min={1}
                          max={30}
                          onChange={(e) => setStageCapacity(Number(e.target.value))}
                        />
                      </label>
                    </div>
                    <label className={sharedStyles.checkboxField}>
                      <Checkbox checked={protectedRoom} onCheckedChange={setProtectedRoom} />
                      密码房
                    </label>
                    {protectedRoom && (
                      <p className={cn(sharedStyles.formNote, styles.roomMeta)}>
                        演示密码：{DEMO_ROOM_PASSWORD}
                      </p>
                    )}
                    {error && (
                      <p className={cn(sharedStyles.inlineError, styles.roomMeta)}>{error}</p>
                    )}
                    <Button type="submit" className="w-full mt-5">
                      保存设置
                    </Button>
                  </form>
                  <section className={styles.memberManagement} aria-label="房间成员管理">
                    <h3 className={styles.managementTitle}>成员管理</h3>
                    {snapshot.members.map((member) => (
                      <div className={styles.memberManagementRow} key={member.userId}>
                        <Avatar size="sm">
                          <AvatarFallback>{member.name.slice(0, 1)}</AvatarFallback>
                        </Avatar>
                        <span>
                          {member.name}
                          {member.userId === user.id && '（你）'}
                        </span>
                        {member.isOwner && <Crown size={12} className="text-primary" />}
                        {member.userId !== user.id && (
                          <Button
                            className={styles.removeMemberButton}
                            variant="ghost"
                            size="sm"
                            aria-label={`移出 ${member.name}`}
                            onClick={() => command((service) => service.kick(member.userId))}
                          >
                            移出
                          </Button>
                        )}
                      </div>
                    ))}
                  </section>
                  <div className={styles.dangerZone}>
                    <p className={cn(styles.roomMeta, styles.dangerDescription)}>
                      结束房间后，参与者可以在历史中查看共同记忆。
                    </p>
                    <AlertDialog open={dissolveOpen} onOpenChange={setDissolveOpen}>
                      <AlertDialogTrigger render={<Button variant="destructive" />}>
                        结束房间
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>确认结束房间？</AlertDialogTitle>
                          <AlertDialogDescription>
                            所有成员将退出。参与者可在七天内通过房间历史查看和生成总结。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>取消</AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={() =>
                              command((service) => {
                                service.dissolve()
                                setDissolveOpen(false)
                                setSettingsOpen(false)
                                router.push('/rooms/history')
                              })
                            }
                          >
                            确认结束
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </DialogContent>
              </Dialog>
            )}
            <Button variant="outline" size="sm" onClick={() => router.push('/rooms')}>
              <LogOut />
              离开
            </Button>
          </div>
        </header>
        {error && (
          <p className={sharedStyles.inlineError} role="alert">
            {error}
          </p>
        )}
        {snapshot.connection === 'reconnecting' && (
          <div className={styles.connectionBanner}>正在恢复房间连接，期间暂不能操作。</div>
        )}
        <div className={styles.roomContent}>
          <section className={styles.roomMain}>
            <section className={styles.participantsPanel} aria-label="房间成员与上台顺序">
              <div className={styles.participantsHeading}>
                <h2 className={styles.participantsTitle}>
                  房间成员{' '}
                  <span className={styles.memberCount}>
                    {snapshot.members.length} / {snapshot.room.maxMembers}
                  </span>
                </h2>
                <div
                  className={styles.roomMemberAvatarStrip}
                  role="group"
                  aria-label="房间成员头像"
                >
                  <AvatarGroup className={styles.memberAvatarGroup}>
                    {snapshot.members.map((member) => (
                      <Avatar
                        key={member.userId}
                        size="sm"
                        role="img"
                        aria-label={member.name}
                        title={`${member.name}${member.userId === user.id ? '（你）' : ''}${member.isOwner ? ' · 房主' : ''}`}
                      >
                        <AvatarFallback>{member.name.slice(0, 1)}</AvatarFallback>
                      </Avatar>
                    ))}
                  </AvatarGroup>
                </div>
                <span className={styles.stageCount}>
                  上台 {snapshot.stageIds.length} / {snapshot.room.maxStageMembers}
                </span>
                <Button
                  variant={onStage ? 'outline' : 'secondary'}
                  size="sm"
                  disabled={snapshot.connection !== 'joined'}
                  onClick={() => command((service) => service.toggleStage())}
                >
                  {onStage ? <ArrowDown /> : <ArrowUp />}
                  {onStage ? '下台' : '上台'}
                </Button>
              </div>
              <div className={styles.stageMemberList} role="list" aria-label="上台成员">
                {snapshot.stageIds.map((memberId, stageIndex) => {
                  const member = snapshot.members.find((member) => member.userId === memberId)!
                  const isPlaying = snapshot.playback.activeMemberId === member.userId
                  return (
                    <div
                      key={member.userId}
                      role="listitem"
                      aria-label={`${member.name}，上台顺序 ${stageIndex + 1}${isPlaying ? '，播放中' : ''}`}
                      className={styles.stageMember}
                    >
                      <div className={styles.stageMemberAvatar}>
                        <Avatar size="lg">
                          <AvatarFallback
                            className={isPlaying ? styles.playingAvatarFallback : undefined}
                          >
                            {member.name.slice(0, 1)}
                          </AvatarFallback>
                        </Avatar>
                        <span className={styles.stageMemberOrder}>{stageIndex + 1}</span>
                      </div>
                      <span className={styles.stageMemberName} title={member.name}>
                        {member.name}
                        {member.userId === user.id && '（你）'}
                        {member.isOwner && <Crown size={12} className="text-primary" />}
                      </span>
                      <span className={styles.stageMemberStatus}>
                        {isPlaying && (
                          <span className={styles.stagePlayingIndicator}>
                            <AudioLines size={12} />
                            播放中
                          </span>
                        )}
                      </span>
                      {mine && member.userId !== user.id && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className={styles.stageMemberRemove}
                          aria-label={`让 ${member.name} 下台`}
                          onClick={() => command((service) => service.leaveStage(member.userId))}
                        >
                          <ArrowDown />
                        </Button>
                      )}
                    </div>
                  )
                })}
                {!snapshot.stageIds.length && (
                  <p className={styles.stageMemberEmpty}>暂无上台成员</p>
                )}
              </div>
            </section>
            <div className={styles.nowPlayingPanel}>
              <h3 className={styles.nowPlayingTitle}>正在播放</h3>
              {snapshot.playback.track ? (
                <>
                  <img
                    className={styles.roomAlbum}
                    src={snapshot.playback.track.cover_url!}
                    alt="当前演示歌曲封面"
                  />
                  <h2 className={styles.trackTitle}>{snapshot.playback.track.title}</h2>
                  <p className={styles.trackAuthor}>{snapshot.playback.track.author}</p>
                  <div className={styles.roomLyrics}>
                    <p>把此刻的风，留在旋律里面</p>
                    <p className={styles.lyricCurrent}>和你一起，听见慢下来的时间</p>
                    <p>不急着赶路，不急着说再见</p>
                  </div>
                  <span className={styles.demoAudioLabel}>本地原创演示音频 · 非平台原曲</span>
                </>
              ) : (
                <div className={styles.waitingStage}>
                  <h2 className={cn(styles.trackTitle, styles.waitingTitle)}>等待上台</h2>
                  <SheetTrigger render={<Button variant="outline" />}>
                    <ListMusic className={playerStyles.queueIcon} />
                    我的房间歌单
                  </SheetTrigger>
                </div>
              )}
            </div>
          </section>
          <aside className={styles.chatPanel}>
            <div className={styles.chatHeader}>
              <h2 className={styles.chatTitle}>聊天</h2>
              <span className={sharedStyles.liveDot} />
            </div>
            <div className={styles.chatMessages} ref={chatMessages}>
              {snapshot.messages.map((m) => (
                <div
                  className={cn(styles.chatMessage, m.senderId === user.id && styles.self)}
                  key={m.id}
                >
                  <span className={cn(sharedStyles.avatar, sharedStyles.avatarXs)}>
                    {m.senderName.slice(0, 1)}
                  </span>
                  <div className={styles.chatBody}>
                    <span className={styles.chatAuthor}>
                      {m.senderName}
                      <time className={styles.chatTime}>
                        {new Date(m.createdAt).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </span>
                    <p className={styles.chatBubble}>{m.content}</p>
                  </div>
                </div>
              ))}
            </div>
            <form className={styles.chatForm} onSubmit={send}>
              <Textarea
                variant="chat"
                className={styles.chatInput}
                aria-label="聊天消息"
                placeholder="输入消息"
                value={message}
                maxLength={120}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send(e)
                  }
                }}
              />
              <div className={styles.chatActions}>
                <span className={styles.chatCount}>{Array.from(message).length}/120</span>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!message.trim() || snapshot.connection !== 'joined'}
                >
                  <Send />
                  发送
                </Button>
              </div>
            </form>
          </aside>
        </div>
        <RoomDock
          snapshot={snapshot}
          onSkip={() => command((s) => s.skip())}
          unlock={unlockAudio}
          error={audioError}
        />
        <RoomPlaylistSheet
          snapshot={snapshot}
          open={queueOpen}
          error={error}
          onAdd={add}
          onMove={(track, toIndex) => command((service) => service.moveTrack(track, toIndex))}
          onRemove={(track) => command((service) => service.removeTrack(track))}
          onAction={(action) => void playlistAction(action)}
        />
      </div>
    </Sheet>
  )
}
