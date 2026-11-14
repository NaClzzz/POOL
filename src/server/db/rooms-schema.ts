import { sql } from 'drizzle-orm'
import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
import { user } from './schema'
import type { Track } from '@/contracts/domain'
import type { Playback } from '@/contracts/room'

/** 活动房间和结束后的七天归档。 */
export const rooms = pgTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    name: text('name').notNull(),
    tag: text('tag').notNull(),
    passwordHash: text('password_hash'),
    maxMembers: integer('max_members').notNull(),
    maxStageMembers: integer('max_stage_members').notNull(),
    memberCount: integer('current_member_count').notNull().default(0),
    status: text('status').$type<'active' | 'ended'>().notNull().default('active'),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    emptyExpiresAt: timestamp('empty_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    index('rooms_status_active_idx').on(t.status, t.lastActiveAt),
    index('rooms_owner_idx').on(t.ownerId, t.status),
    index('rooms_expiry_idx').on(t.expiresAt),
    check(
      'rooms_capacity_check',
      sql`${t.maxMembers} between 2 and 50 and ${t.maxStageMembers} between 1 and 30 and ${t.maxStageMembers} <= ${t.maxMembers}`,
    ),
  ],
)
/** 可重置的在线投影；不是历史访问权限。 */
export const roomMembers = pgTable(
  'room_members',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.roomId, t.userId] }),
    uniqueIndex('room_members_one_active_idx')
      .on(t.userId)
      .where(sql`${t.leftAt} is null`),
  ],
)
/** 成功加入产生的本人访问凭证，事务内限制每人最多五十条。 */
export const roomHistory = pgTable(
  'room_history',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    firstJoinedAt: timestamp('first_joined_at', { withTimezone: true }).notNull(),
    lastJoinedAt: timestamp('last_joined_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roomId] }),
    index('room_history_user_time_idx').on(t.userId, t.lastJoinedAt, t.roomId),
  ],
)
/** 用户跨房间保留的独立上台歌单，track 为统一资料快照。 */
export const roomPlaylistItems = pgTable(
  'user_room_playlist_items',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    track: jsonb('track').$type<Track>().notNull(),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('room_playlist_user_track_idx').on(t.userId, t.source, t.sourceId),
    index('room_playlist_position_idx').on(t.userId, t.position),
  ],
)
/** 当前节目持久投影；JSON 时间轴和轮播游标一次原子写入，重启不恢复播放。 */
export const roomPlaybackStates = pgTable('room_playback_states', {
  roomId: text('room_id')
    .primaryKey()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  playback: jsonb('playback').$type<Playback>().notNull(),
  activeIndex: integer('active_index').notNull().default(-1),
})
/** 最新一万条聊天消息，房间结束后不提供读取接口。 */
export const roomMessages = pgTable(
  'room_messages',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    senderName: text('sender_name').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('room_messages_time_idx').on(t.roomId, t.createdAt, t.id)],
)
/** 已到起播时间的最新五百个节目，为后续总结保留输入。 */
export const roomPlayedSongs = pgTable(
  'room_played_songs',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => user.id),
    track: jsonb('track').$type<Track>().notNull(),
    playbackVersion: integer('playback_version').notNull(),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('room_played_version_idx').on(t.roomId, t.playbackVersion),
    index('room_played_time_idx').on(t.roomId, t.playedAt),
  ],
)
