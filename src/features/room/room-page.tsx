'use client'
import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet } from '@/components/ui/sheet'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Loading, ErrorState } from '@/components/feedback'
import { RoomCommandError } from '@/lib/socket-client'
import { useSession } from '@/stores/session'
import { useRoomSession } from './use-room-session'
import { useRoomAudio } from './use-room-audio'
import { RoomHeader } from './room-header'
import { RoomParticipants } from './room-participants'
import { RoomNowPlaying } from './room-now-playing'
import { RoomChat } from './room-chat'
import { RoomDock } from './room-dock'
import { RoomPlaylistSheet } from './room-playlist-sheet'
import styles from './room-page.module.css'
import shared from '@/components/presentation.module.css'

/** 页面只组合房间界面；连接、实时状态和音频分别由专用 hook 维护。 */
export function RoomPage({ code }: { code: string }) {
  const userId = useSession((s) => s.user!.id)
  const session = useRoomSession(code)
  const { snapshot, connection, error, command } = session
  const [password, setPassword] = useState('')
  const [queueOpen, setQueueOpen] = useState(false)
  const onMediaError = useCallback(
    (version: number, itemId: string) => {
      if (snapshot?.playback.activeMemberId === userId)
        void command('room:playback:media-error', { version, itemId })
    },
    [snapshot?.playback.activeMemberId, userId, command],
  )
  const {
    audioRef,
    error: audioError,
    needsUnlock,
    unlock,
  } = useRoomAudio(snapshot?.playback, connection === 'joined', session.clockOffset, onMediaError)
  const needsPassword = error instanceof RoomCommandError && error.code === 'ROOM_PASSWORD_REQUIRED'
  const needsSwitch = error instanceof RoomCommandError && error.code === 'ALREADY_IN_ROOM'
  if (!snapshot || needsPassword || needsSwitch)
    return (
      <div className={styles.joinPage}>
        <Button variant="outline" size="sm" onClick={session.leave}>
          离开
        </Button>
        {needsPassword ? (
          <div className={styles.passwordCard}>
            <h1 className={styles.passwordTitle}>房间密码</h1>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void session.join(password)
              }}
            >
              <Input
                aria-label="房间密码"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
              <p className={shared.inlineError}>{error.message}</p>
              <Button type="submit" className="mt-4 w-full">
                进入房间
              </Button>
            </form>
          </div>
        ) : needsSwitch ? (
          <AlertDialog open>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>切换房间？</AlertDialogTitle>
                <AlertDialogDescription>你在其他页面加入的房间也会退出。</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={session.leave}>取消</AlertDialogCancel>
                <AlertDialogAction onClick={() => void session.join(password, true)}>
                  切换
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : error ? (
          <ErrorState error={error} retry={() => void session.join(password)} />
        ) : (
          <Loading />
        )}
      </div>
    )
  return (
    <Sheet modal="trap-focus" open={queueOpen} onOpenChange={setQueueOpen}>
      <div className={styles.roomPage}>
        <audio ref={audioRef} preload="metadata" />
        <RoomHeader
          snapshot={snapshot}
          command={command}
          leave={session.leave}
          connected={connection === 'joined'}
        />
        {connection !== 'joined' && (
          <div className={styles.connectionBanner}>正在恢复房间连接，期间暂不能操作。</div>
        )}
        {error && (
          <p className={shared.inlineError} role="alert">
            {error.message}
          </p>
        )}
        <div className={styles.roomContent}>
          <section className={styles.roomMain}>
            <RoomParticipants
              snapshot={snapshot}
              connected={connection === 'joined'}
              command={command}
            />
            <RoomNowPlaying playback={snapshot.playback} clockOffset={session.clockOffset} />
          </section>
          <RoomChat
            messages={snapshot.messages}
            connected={connection === 'joined'}
            command={command}
          />
        </div>
        <RoomDock
          snapshot={snapshot}
          connected={connection === 'joined'}
          clockOffset={session.clockOffset}
          error={audioError}
          needsUnlock={needsUnlock}
          unlock={unlock}
          onSkip={() =>
            void command(
              snapshot.playback.activeMemberId === userId
                ? 'room:playback:skip'
                : 'room:playback:vote-skip',
              {},
            )
          }
        />
        <RoomPlaylistSheet
          snapshot={snapshot}
          connected={connection === 'joined'}
          open={queueOpen}
          command={command}
        />
      </div>
    </Sheet>
  )
}
