import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { readServerEnv } from '../env'
import * as schema from './schema'

/** 热更新复用数据库连接池，避免每次编译重复建立连接。 */
const databaseGlobal = globalThis as typeof globalThis & { poolDatabase?: Pool }

export const pool =
  databaseGlobal.poolDatabase ??
  new Pool({
    connectionString: readServerEnv().DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
  })
if (process.env.NODE_ENV !== 'production') databaseGlobal.poolDatabase = pool
if (pool.listenerCount('error') === 0) {
  pool.on('error', () => console.error('[db] PostgreSQL 连接不可用'))
}

export const db = drizzle({ client: pool, schema })
