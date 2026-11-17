# 网易云 API 源码

`api-enhanced/` 是普通源码快照，不是 Git submodule，依赖与 POOL 分开维护。

- 上游：<https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced>
- 版本：`@neteasecloudmusicapienhanced/api` 4.41.1。
- 基准提交：`4a7d557326d16d2f1e5172ee69c9471eb3a50173`。
- 许可证：MIT，原文见 [LICENSE](api-enhanced/LICENSE)。
- 锁文件 SHA-256：`4819f51099c4b6b310066fc1338a57652ce60dacd754cc891d1be8c9a1790cb9`。

源码来自本地上游仓库的已跟踪文件；不带嵌套 `.git`、`node_modules`、真实 `.env`、日志、临时匿名令牌或生成的密钥文件。不复制 `.codegraph` 工具目录或本地实验用 `Dockerfile.local`。接口实现、package.json 和锁文件保持原样。打包改动仅为 `.dockerignore` 的运行文件过滤与 `Dockerfile` 的 `NODE_IMAGE` 基础镜像参数；默认仍使用上游 `node:lts-alpine`，允许网络受限时替换镜像来源，不改安装与启动流程。

本地安装：

```sh
pnpm --dir vendor/api-enhanced install --frozen-lockfile --prod --ignore-scripts
pnpm music:dev
```

上游锁格式为 pnpm 9，Dockerfile 使用 pnpm 9；本地 pnpm 12 可读取该锁。不要在 POOL 根包添加音源依赖，也不要用 POOL 的格式化／类型检查／Lint 工具处理第三方代码。

生产由 `compose.production.yaml` 的 `music` 服务使用此目录独立构建。上游 Dockerfile 安装生产依赖并用 tini 启动一个 Node 进程；匿名令牌与临时公钥由上游在容器临时目录生成，不需要复制、持久化或预置 Cookie。健康探针读取静态首页，不代表上游网易云可用。上游基础镜像 `node:lts-alpine` 和 pnpm 9 跟随其原配置，更新构建前需复核版本；POOL 自有镜像使用单独的 Node 构建参数。

更新源码时从上游目标提交重新生成快照，审查差异，保持包与锁文件配套，并更新本文件中的版本、提交和校验值；不得覆盖真实凭据到仓库。
