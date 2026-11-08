import 'server-only'
import { z } from 'zod'

/** 服务端配置在模块入口统一校验，不向浏览器暴露连接信息或认证密钥。 */
const serverEnvSchema = z.object({
  DATABASE_URL: z
    .url()
    .refine((value) => /^postgres(ql)?:/.test(value), '需要 PostgreSQL 连接地址'),
  REDIS_URL: z.url().refine((value) => /^rediss?:/.test(value), '需要 Redis 连接地址'),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  MUSIC_API_BASE_URL: z.url().default('http://127.0.0.1:3001'),
  AUTH_TRUST_PROXY: z.enum(['true', 'false']).default('false'),
})

/** 当前进程已验证的配置，只在首次读取时解析环境变量。 */
let cachedEnv: z.infer<typeof serverEnvSchema> | undefined

/** 从进程环境取得已验证的服务端配置；错误只列字段，不输出密钥值。 */
export function readServerEnv() {
  if (cachedEnv) return cachedEnv
  const result = serverEnvSchema.safeParse(process.env)
  if (!result.success) {
    throw new Error(
      `请检查服务端环境变量：${result.error.issues.map((issue) => issue.path.join('.')).join('、')}`,
    )
  }
  cachedEnv = result.data
  return cachedEnv
}
