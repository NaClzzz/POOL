import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

// 生产一次性入口：仅使用数据库配置，执行仓库内已提交迁移，不生成新 SQL。
if (!process.env.DATABASE_URL) throw new Error('请配置 DATABASE_URL')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
try {
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' })
  console.log('数据库迁移完成')
} catch (error) {
  // 不打印可能包含连接串的原始异常；错误码足够定位部署失败。
  console.error('数据库迁移失败', error.code ?? error.name)
  process.exitCode = 1
} finally {
  await pool.end()
}
