import type { NextConfig } from 'next'

const config: NextConfig = {
  poweredByHeader: false,
  output: 'standalone',
  typescript: {
    // 生产容器在 CI 类型检查通过后通过 SKIP_TYPECHECK=1 跳过重复 tsc，降低小内存机器峰值内存。
    ignoreBuildErrors: process.env.SKIP_TYPECHECK === '1',
  },
}
export default config
