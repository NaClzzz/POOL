import 'server-only'
import { z } from 'zod'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError } from 'ai'
import { BusinessError } from '../http/errors'

/** 模型配置独立按需校验，未配置 AI 密钥时不影响账号和音乐服务。 */
const configSchema = z.object({
  DASHSCOPE_API_KEY: z.string().trim().min(1),
  DASHSCOPE_BASE_URL: z
    .url()
    .default('https://ws-hmgfth5uyiijbxu5.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),
  DASHSCOPE_MODEL: z.string().trim().min(1).default('qwen3.8-flash'),
})

/** 只选择指定模型，不回退其他模型或输出服务端凭据。 */
export function createBailianModel() {
  const parsed = configSchema.safeParse(process.env)
  if (!parsed.success)
    throw new BusinessError('AI_NOT_CONFIGURED', 'AI 服务尚未配置，请联系管理员', 503)
  return createOpenAICompatible({
    name: 'bailian',
    baseURL: parsed.data.DASHSCOPE_BASE_URL,
    apiKey: parsed.data.DASHSCOPE_API_KEY,
    includeUsage: true,
  })(parsed.data.DASHSCOPE_MODEL)
}

/** 提供稳定可读错误，不将供应商响应正文、地址或请求头发送给客户端。 */
export function aiError(error: unknown): BusinessError {
  if (error instanceof BusinessError) return error
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
    return new BusinessError('AI_TIMEOUT', '生成已中断或超时，请手动重试', 504)
  if (APICallError.isInstance(error)) {
    if (
      error.statusCode === 413 ||
      /context.{0,25}(length|limit)|maximum context|input.{0,20}too long/i.test(error.message)
    )
      return new BusinessError('AI_INPUT_TOO_LARGE', '输入超过模型上下文限制，未截断原始资料', 422)
    if (error.statusCode === 401 || error.statusCode === 403)
      return new BusinessError(
        'AI_CONFIGURATION_ERROR',
        'AI 服务访问被拒绝，请联系管理员检查配置',
        502,
      )
    if (error.statusCode === 404)
      return new BusinessError('AI_MODEL_UNAVAILABLE', '配置的模型或接口不可用，请联系管理员', 502)
    if (error.statusCode === 429)
      return new BusinessError('AI_UPSTREAM_RATE_LIMITED', '模型服务请求受限，请稍后手动重试', 502)
  }
  return new BusinessError('AI_UNAVAILABLE', 'AI 生成失败，请稍后手动重试', 502)
}
