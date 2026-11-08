import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  primaryKey,
  index,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { user } from './schema'

/** 收藏直接保存统一歌曲快照，以用户和平台身份联合唯一，不建歌曲实体表。 */
export const likedSongs = pgTable(
  'liked_songs',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    source: text('source').$type<'netease' | 'bilibili'>().notNull(),
    source_id: text('source_id').notNull(),
    title: text('title'),
    author: text('author'),
    album: text('album'),
    duration_ms: integer('duration_ms'),
    cover_url: text('cover_url'),
    extra: jsonb('extra').$type<Record<string, unknown> | null>(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.source, table.source_id] }),
    index('liked_songs_user_added_idx').on(table.userId, table.addedAt.desc()),
    check('liked_songs_source_check', sql`${table.source} in ('netease', 'bilibili')`),
    check(
      'liked_songs_duration_check',
      sql`${table.duration_ms} is null or ${table.duration_ms} > 0`,
    ),
  ],
)
