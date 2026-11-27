import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/** 使用 esbuild 编译独立 Node 服务端入口，生产依赖由容器直接安装。 */
async function buildEntry(name, entry) {
  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: resolve(root, 'dist', `${name}.mjs`),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node24',
  })
  console.log(`${name}: 已编译 dist/${name}.mjs`)
}

await rm(resolve(root, 'dist'), { recursive: true, force: true })
await buildEntry('socket', 'socket-server/index.ts')
await buildEntry('migrate', 'scripts/migrate.mjs')
