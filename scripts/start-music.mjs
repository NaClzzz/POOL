import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 音源使用仓库内独立依赖，不启动 POOL Web，也不自动安装依赖。
const source = fileURLToPath(new URL('../vendor/api-enhanced/', import.meta.url))
if (!existsSync(new URL('../vendor/api-enhanced/node_modules/', import.meta.url)))
  throw new Error(
    '请先执行 pnpm --dir vendor/api-enhanced install --frozen-lockfile --prod --ignore-scripts',
  )
const address = new URL(process.env.MUSIC_API_BASE_URL || 'http://127.0.0.1:3001')
// 独立音源进程不继承 POOL 数据库密码或认证密钥。
const sourceEnv = { ...process.env }
for (const key of [
  'DATABASE_URL',
  'REDIS_URL',
  'BETTER_AUTH_SECRET',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'ROOM_INTERNAL_SECRET',
  'DASHSCOPE_API_KEY',
])
  delete sourceEnv[key]
const child = spawn(process.execPath, ['app.js'], {
  cwd: source,
  stdio: 'inherit',
  env: {
    ...sourceEnv,
    PORT: address.port || '3001',
    HOST: address.hostname,
    NETEASE_COOKIE: '',
    ENABLE_GENERAL_UNBLOCK: 'false',
  },
})
// 父终端停止时一并清理本次创建的源码进程。
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code) => {
  process.exitCode = code ?? 0
})
