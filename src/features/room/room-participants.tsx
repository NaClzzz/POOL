'use client'
import { ArrowDown, ArrowUp, AudioLines, Crown } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarGroup } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { useSession } from '@/stores/session'
import type { RoomSnapshot } from '@/contracts/room'
import type { RoomCommand } from './types'
import styles from './room-page.module.css'

/** 在线成员与上台顺序分别展示，房主可让其他成员下台。 */
export function RoomParticipants({
  snapshot,
  connected,
  command,
}: {
  snapshot: RoomSnapshot
  connected: boolean
  command: RoomCommand
}) {
  const userId = useSession((s) => s.user!.id),
    mine = snapshot.room.ownerId === userId,
    onStage = snapshot.stageIds.includes(userId)
  return (
    <section className={styles.participantsPanel} aria-label="房间成员与上台顺序">
      <div className={styles.participantsHeading}>
        <h2 className={styles.participantsTitle}>
          房间成员{' '}
          <span className={styles.memberCount}>
            {snapshot.members.length} / {snapshot.room.maxMembers}
          </span>
        </h2>
        <div className={styles.roomMemberAvatarStrip} role="group" aria-label="房间成员头像">
          <AvatarGroup className={styles.memberAvatarGroup}>
            {snapshot.members.map((m) => (
              <Avatar key={m.userId} size="sm" title={`${m.name}${m.isOwner ? ' · 房主' : ''}`}>
                <AvatarFallback>{m.name.slice(0, 1)}</AvatarFallback>
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
          disabled={!connected}
          onClick={() => void command(onStage ? 'room:stage:leave' : 'room:stage:join', {})}
        >
          {onStage ? <ArrowDown /> : <ArrowUp />}
          {onStage ? '下台' : '上台'}
        </Button>
      </div>
      <div className={styles.stageMemberList} role="list" aria-label="上台成员">
        {snapshot.stageIds.map((id, index) => {
          const member = snapshot.members.find((m) => m.userId === id)!,
            playing = snapshot.playback.activeMemberId === id
          return (
            <div key={id} role="listitem" className={styles.stageMember}>
              <div className={styles.stageMemberAvatar}>
                <Avatar size="lg">
                  <AvatarFallback className={playing ? styles.playingAvatarFallback : undefined}>
                    {member.name.slice(0, 1)}
                  </AvatarFallback>
                </Avatar>
                <span className={styles.stageMemberOrder}>{index + 1}</span>
              </div>
              <span className={styles.stageMemberName}>
                {member.name}
                {id === userId && '（你）'}
                {member.isOwner && <Crown size={12} className="text-primary" />}
              </span>
              <span className={styles.stageMemberStatus}>
                {playing && (
                  <span className={styles.stagePlayingIndicator}>
                    <AudioLines size={12} />
                    播放中
                  </span>
                )}
              </span>
              {mine && id !== userId && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={!connected}
                  className={styles.stageMemberRemove}
                  aria-label={`让 ${member.name} 下台`}
                  onClick={() => void command('room:stage:leave', { targetUserId: id })}
                >
                  <ArrowDown />
                </Button>
              )}
            </div>
          )
        })}
        {!snapshot.stageIds.length && <p className={styles.stageMemberEmpty}>暂无上台成员</p>}
      </div>
    </section>
  )
}
