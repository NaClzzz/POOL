import 'server-only'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { z } from 'zod'
import { db } from '../db'
import * as schema from '../db/schema'
import { readServerEnv } from '../env'
import { authRateLimitStorage } from './rate-limit'

const env = readServerEnv()

/** 昵称只在注册／修改资料的认证入口校验，业务模块不重复清洗。 */
const nameSchema = z.string().trim().min(1).max(30)

/** 独立于 Next 请求上下文的认证核心，可供 HTTP 及后续 Socket 握手复用。 */
export const auth = betterAuth({
  appName: 'POOL',
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    requireEmailVerification: false,
    autoSignIn: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: false },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 60, max: 3 },
      '/change-password': { window: 60, max: 5 },
      '/get-session': false,
      '/sign-out': false,
    },
    customStorage: authRateLimitStorage,
  },
  advanced: {
    cookiePrefix: 'pool',
    ipAddress: {
      ipAddressHeaders: ['x-pool-client-ip'],
    },
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (context.path === '/change-password') context.body.revokeOtherSessions = true
      if (context.path === '/sign-up/email' || context.path === '/update-user') {
        const result = nameSchema.safeParse(context.body?.name)
        if (!result.success)
          throw new APIError('BAD_REQUEST', {
            code: 'INVALID_NAME',
            message: '昵称需要 1～30 个字符',
          })
        context.body.name = result.data
      }
    }),
  },
})
