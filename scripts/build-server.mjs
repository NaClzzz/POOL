import { build } from 'esbuild'
import { nodeFileTrace } from '@vercel/nft'
import { copyFile, lstat, mkdir, readFile, readlink, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { devDependencies } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)
// 认证遥测会探测包版本；不为这些探测把开发工具的元数据和链接带入镜像。
const developmentPackages = new Set(Object.keys(devDependencies))

/** 同时识别顶层和 pnpm 虚拟存储中的开发包，兼容 Windows 分隔符。 */
function isDevelopmentDependency(file) {
  const path = file.replaceAll('\\', '/').split('node_modules/').at(-1)
  const name = path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0]
  return developmentPackages.has(name)
}

/** 编译独立进程并复制实际依赖；不把 tsx、业务源码或完整开发依赖带入运行镜像。 */
async function buildRuntime(name, entry) {
  const output = resolve(root, 'dist', name)
  const relativeOutput = relative(root, output)
  if (isAbsolute(relativeOutput) || relativeOutput.startsWith('..'))
    throw new Error('构建输出必须位于项目内')
  await rm(output, { recursive: true, force: true })
  const compiled = resolve(root, 'dist', 'entries', `${name}.mjs`)
  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: compiled,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node24',
  })
  const { fileList } = await nodeFileTrace([compiled], {
    base: root,
    processCwd: root,
    conditions: ['node', 'react-server'],
    ignore: isDevelopmentDependency,
  })
  // 保留 pnpm 的相对符号链接及其真实文件路径，确保产物脱离源码仍可运行。
  for (const file of fileList) {
    if (isDevelopmentDependency(file)) continue
    const source = join(root, file)
    const destination = join(output, file)
    await mkdir(dirname(destination), { recursive: true })
    if ((await lstat(source)).isSymbolicLink()) {
      const target = join(output, relative(root, resolve(dirname(source), await readlink(source))))
      await symlink(
        process.platform === 'win32' ? target : relative(dirname(destination), target),
        destination,
        'junction',
      )
    } else await copyFile(source, destination)
  }
  console.log(`${name}: 已生成独立运行目录 (${fileList.size} files)`)
}

await buildRuntime('socket', 'socket-server/index.ts')
await buildRuntime('migrate', 'scripts/migrate.mjs')
