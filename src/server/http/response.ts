import type { ApiResult } from '@/contracts/domain'

/** 普通业务 HTTP JSON 的统一成功响应，私有结果不进入共享缓存。 */
export function success<T>(data: T, requestId: string, status = 200) {
  return Response.json({ ok: true, data, requestId } satisfies ApiResult<T>, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

/** 普通业务 HTTP JSON 的统一错误响应，不输出内部堆栈和连接信息。 */
export function failure(code: string, message: string, status: number, requestId: string) {
  return Response.json(
    { ok: false, error: { code, message }, requestId } satisfies ApiResult<never>,
    {
      status,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
