import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// 源码依赖独立运行，不启动 POOL Web，也不自动安装或修改外部项目。
const source = process.env.NETEASE_SOURCE_DIR
if (!source || !existsSync(resolve(source, 'app.js')))
  throw new Error('请在 .env 配置 NETEASE_SOURCE_DIR，指向 api-enhanced 源码目录')
const address = new URL(process.env.MUSIC_API_BASE_URL || 'http://127.0.0.1:3001')
// 独立音源进程不继承 POOL 数据库密码或认证密钥。
const sourceEnv = { ...process.env }
for (const key of [
  'DATABASE_URL',
  'REDIS_URL',
  'BETTER_AUTH_SECRET',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
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
