import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // 封面均为本地 SVG，无需图片优化代理；本原型未启用 React Compiler。
  { rules: { '@next/next/no-img-element': 'off', 'react-hooks/incompatible-library': 'off' } },
  globalIgnores(['.next/**', 'next-env.d.ts', 'public/**']),
])
