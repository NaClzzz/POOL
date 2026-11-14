import { z } from 'zod'
import { referenceSchema } from '../music/validation'

/** HTTP 创建及 Socket 设置入口共用容量和名称约束。 */
export const createRoomSchema = z
  .object({
    name: z.string().trim().min(2).max(20),
    tag: z.string().trim().min(2).max(12),
    maxMembers: z.number().int().min(2).max(50),
    maxStageMembers: z.number().int().min(1).max(30),
    password: z.string().min(6).max(64).optional(),
  })
  .refine((v) => v.maxStageMembers <= v.maxMembers, '上台人数不能超过房间人数')
/** 设置密码不返回原文，keep 不要求重新输入。 */
export const settingsSchema = createRoomSchema
  .safeExtend({ passwordAction: z.enum(['keep', 'set', 'remove']) })
  .refine((v) => v.passwordAction !== 'set' || !!v.password, '请输入新密码')
const empty = z.object({})
const join = z.object({
  roomCode: z.string().min(1).max(80),
  password: z.string().max(64).optional(),
})
/** 所有 Socket 载荷只在接收入口校验一次。 */
export const commandSchemas = {
  'room:join': join,
  'room:switch': join,
  'room:sync': empty,
  'room:leave': empty,
  'room:stage:join': empty,
  'room:stage:leave': z.object({ targetUserId: z.string().min(1).max(160).optional() }),
  'room:playlist:add': referenceSchema,
  'room:playlist:remove': z.object({ itemId: z.string().min(1).max(160) }),
  'room:playlist:reorder': z.object({
    itemId: z.string().min(1).max(160),
    toIndex: z.number().int().min(0).max(499),
  }),
  'room:playlist:shuffle': empty,
  'room:playlist:clear': empty,
  'room:playlist:import-liked': empty,
  'room:chat:send': z.object({
    content: z
      .string()
      .trim()
      .min(1)
      .refine((v) => Array.from(v).length <= 120, '消息最多 120 字符'),
  }),
  'room:playback:skip': empty,
  'room:playback:vote-skip': empty,
  'room:playback:media-error': z.object({
    version: z.number().int().min(0),
    itemId: z.string().min(1).max(160),
  }),
  'room:update-settings': settingsSchema,
  'room:kick-member': z.object({ targetUserId: z.string().min(1).max(160) }),
  'room:dissolve': empty,
}
