import { pgTable, text, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { rooms } from './rooms-schema'
import { user } from './schema'

/** 每房唯一共享总结及当前尝试；成功正文与房间归档一起级联清理。 */
export const roomSummaries = pgTable(
  'room_summaries',
  {
    roomId: text('room_id')
      .primaryKey()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    status: text('status').$type<'generating' | 'failed' | 'succeeded'>().notNull(),
    attemptId: text('attempt_id').notNull(),
    requestedBy: text('requested_by')
      .notNull()
      .references(() => user.id),
    content: text('content'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    errorCode: text('error_code'),
  },
  (t) => [
    check('room_summary_status_check', sql`${t.status} in ('generating','failed','succeeded')`),
    check(
      'room_summary_content_check',
      sql`(${t.status} = 'succeeded' and ${t.content} is not null and ${t.generatedAt} is not null) or (${t.status} <> 'succeeded' and ${t.content} is null)`,
    ),
  ],
)
