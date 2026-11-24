import axios from 'axios'
import { z } from 'zod'
import { authClient } from './auth-client'

/** 普通业务 JSON 使用原生 Axios 实例；不额外限制导入时长或自动重试。 */
export const http = axios.create({
  baseURL: '/api',
  responseType: 'json',
  transitional: { silentJSONParsing: false },
  validateStatus: null,
  timeout: 0,
})

/** 传输边界只校验响应外壳，业务数据类型由具体接口声明。 */
const resultSchema = z.discriminatedUnion('ok', [
  z
    .object({ ok: z.literal(true), data: z.unknown(), requestId: z.string() })
    .refine((value) => Object.hasOwn(value, 'data')),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
    requestId: z.string(),
  }),
])

/** 页面仅在需要额外界面联动时传入成功回调。 */
export type MutationSuccessOptions<TData, TVariables = void> = {
  onSuccess?: (data: TData, variables: TVariables) => void | Promise<void>
}

/** 页面据此判断业务错误和限流等待时间，请求层不负责显示提示。 */
export class HttpError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public retryAfter: number | null,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

http.interceptors.response.use(
  /** HTTP 响应集中校验；成功时保留原始 Axios 响应，由接口方法显式取数据。 */
  (response) => {
    if (response.status === 401) void authClient.getSession()
    const parsed = resultSchema.safeParse(response.data)
    if (!parsed.success || (parsed.data.ok && (response.status < 200 || response.status >= 300))) {
      throw new HttpError(
        'INVALID_RESPONSE',
        '服务返回的数据格式异常，请稍后重试',
        response.status,
        null,
      )
    }
    if (!parsed.data.ok) {
      throw new HttpError(
        parsed.data.error.code,
        parsed.data.error.message,
        response.status,
        Number(response.headers['retry-after']) || null,
      )
    }
    return response
  },
  (error: unknown) => {
    if (axios.isCancel(error)) throw new DOMException('请求已取消', 'AbortError')
    const invalid = axios.isAxiosError(error) && error.code === 'ERR_BAD_RESPONSE'
    throw new HttpError(
      invalid ? 'INVALID_RESPONSE' : 'NETWORK_ERROR',
      invalid ? '服务返回的数据格式异常，请稍后重试' : '无法连接服务，请检查网络后重试',
      axios.isAxiosError(error) ? (error.response?.status ?? 0) : 0,
      null,
    )
  },
)
