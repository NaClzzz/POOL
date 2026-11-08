# POOL

桌面端一起听音乐项目。账号系统已接入 Better Auth、PostgreSQL 和 Cookie Session，Redis 用于认证限流；音乐、喜欢、房间、历史和 AI 继续使用 mock，本地原创短音频用于播放演示。

## 本地运行

需要 Node.js 24+、pnpm 和可用的 Docker Compose。依赖锁定于 pnpm-lock.yaml。

```sh
pnpm install
```

首次克隆时将 .env.example 复制为 .env，替换数据库密码、Redis 密码和至少 32 字符的随机认证密钥，确保 DATABASE_URL、REDIS_URL 中的密码与容器一致。已有 .env 时保留当前配置。

```sh
pnpm infra:up
pnpm db:migrate
pnpm dev
```

最后一步由用户手动启动。访问 http://localhost:3000，BETTER_AUTH_URL 必须与浏览器站点地址一致。基础服务端口仅绑定本机回环地址，数据保存在独立 Docker volume；停止使用 pnpm infra:stop，再次启动使用 pnpm infra:up。

Compose 固定官方镜像摘要。拉取受网络限制时通过 .env 的 POSTGRES_IMAGE、REDIS_IMAGE 配置可访问的镜像地址并保持相同摘要，详见 [第二阶段交付](docs/开发阶段/02-基础后端与账号系统.md)。

## 账号与演示路径

1. 在 /register 填写昵称、邮箱和 8～128 位密码，注册成功直接登录。没有演示账号捷径，不发送验证邮件，也不提供邮件找回密码。
2. 在 /settings 查看真实账号、修改昵称和密码。改密需验证当前密码，成功后撤销其他会话；退出撤销当前服务端会话。会话 7 天，持续使用满一天后续期。
3. 搜索页切换网易云／Bilibili、搜索、播放和收藏。曲库为模拟资料，实际播放两段本地 24 秒音频，不请求平台音源。
4. 喜欢页支持模拟歌单导入、顺序／随机播放、队列拖拽和固定内容歌单分析。新账号没有旧演示账号的收藏和历史，先收藏再分析。
5. 大厅加入公开房或密码为 pool2026 的“周末海边散步”。房间歌单双列抽屉左侧搜索、右侧拖拽排序；上下台、投票、轮播和聊天由单浏览器模拟会话驱动。
6. 个人播放跨页保持；离开房间页立即停音并清理模拟连接。房间不提供暂停或拖动进度。
7. 历史和总结仍为 mock。成功加入才记录本人历史，删除历史失去总结访问权；新账号不自动继承预置账号的记录。
8. 设置中的演示选项只控制 mock 的失败、延迟、容量和重置，不修改真实账号、密码和数据库。

## 数据与替换边界

- src/server/auth/：认证核心、HTTP 入口、页面会话校验和 Redis 原子限流；核心可供后续 Socket 服务复用。
- src/server/db/、drizzle/：认证 schema、连接池与版本化迁移，目前只有认证所需四张表。
- GET /api/account：真实 Cookie 鉴权的当前用户接口，使用普通业务 JSON 响应，不接受客户端指定身份。
- /api/auth/*：Better Auth 原生协议，客户端位于 src/lib/auth-client.ts。
- src/features/auth/session-provider.tsx：读取真实会话、同步安全投影和 mock 用户桥接；换号或失效时清理查询及播放。
- src/contracts/：统一曲目和安全用户类型；src/mocks/api.ts、room-session.ts 保留尚未接入后端的业务。
- src/features/、src/components/ui/：桌面交互及 shadcn/ui Base UI，业务样式使用 CSS Modules。

账号与会话保存于 PostgreSQL；Redis 不保存登录会话。浏览器不持久化密码或认证 token，旧 pool:prototype:v1:session 不参与认证。模拟业务资料仍在 localStorage 的 pool:prototype:v1:data，按真实用户主键区分，音量独立保存；旧邮箱键资料不自动迁移。

## 迁移与验证

```sh
pnpm db:generate
pnpm db:migrate
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm format:check
pnpm build
```

db:generate 用于 schema 变更后生成 SQL，首次运行只需执行已提交迁移。认证依赖或配置变化需重新生成 schema 时使用 pnpm auth:generate，检查生成结果后再生成和执行迁移。实际密钥与密码只放在未提交的 .env。

Vitest 覆盖 mock 业务、身份过渡、队列及本地资源。集成测试直接调用认证 HTTP 处理器，连接 .env 的 PostgreSQL 与 Redis，使用随机测试邮箱和专用限流键，结束后仅清理本次测试资料，不启动 Web 服务。它验证真实数据库和会话，不代替浏览器表单验收。

生产构建与运行分别使用 pnpm build、pnpm start。上线配置实际 HTTPS 的 BETTER_AUTH_URL；只有反向代理可信地覆盖 X-Forwarded-For 时才启用 AUTH_TRUST_PROXY=true。默认本地模式使用按端点共享的限流桶，忽略客户端伪造的代理 IP。

## 文档

- [第二阶段：基础后端与账号系统](docs/开发阶段/02-基础后端与账号系统.md)
- [前端原型业务范围](docs/开发阶段/01-前端交互原型.md)
- [当前交付与接入点](docs/开发阶段/01-前端原型完成情况与后端接入准备.md)
- [项目概览](docs/项目概览.md)
- [前端设计](docs/前端设计.md)
- [服务端设计](docs/服务端设计.md)
