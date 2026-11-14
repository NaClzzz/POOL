import { timingSafeEqual } from 'node:crypto'
import { referenceSchema } from '@/server/music/validation'
import { musicService } from '@/server/music/service'
import { success, failure } from '@/server/http/response'
import { BusinessError } from '@/server/http/errors'
import { z } from 'zod'

/** 只供持有独立密钥的 Socket 进程调用；所有外部曲库访问仍集中在 Web。 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  const secret = process.env.ROOM_INTERNAL_SECRET,
    supplied = request.headers.get('x-pool-room-secret')
  if (
    !secret ||
    secret.length < 32 ||
    !supplied ||
    Buffer.byteLength(secret) !== Buffer.byteLength(supplied) ||
    !timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))
  )
    return failure('FORBIDDEN', '请求来源不允许', 403, requestId)
  try {
    const reference = referenceSchema.parse(await request.json())
    return success(
      await musicService.getTrack(reference.source, reference.source_id, reference.extra ?? null),
      requestId,
    )
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return failure('INVALID_INPUT', '请求参数格式不正确', 400, requestId)
    if (error instanceof BusinessError)
      return failure(error.code, error.message, error.status, requestId)
    console.error(`[room-track] 请求失败 ${requestId}`)
    return failure('INTERNAL_ERROR', '音乐服务暂时不可用', 500, requestId)
  }
}
