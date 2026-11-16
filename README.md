# POOL

桌面端一起听音乐项目。账号系统已接入 Better Auth、PostgreSQL 和 Cookie Session，已接通网易云匿名搜索与真实个人播放、PostgreSQL 喜欢及歌单导入；Redis 用于认证／音乐限流和音乐查询缓存。真实一起听与 PostgreSQL 房间历史已接通；喜欢歌单分析和共享房间总结通过 Vercel AI SDK 接入百炼。

## 本地运行

需要 Node.js 24+、pnpm 和可用的 Docker Compose。依赖锁定于 pnpm-lock.yaml。

```sh
pnpm install
```

首次克隆时将 .env.example 复制为 .env，替换数据库密码、Redis 密码、至少 32 字符的随机认证密钥及独立 ROOM_INTERNAL_SECRET，确保 DATABASE_URL、REDIS_URL 中的密码与容器一致。已有 .env 时保留当前配置。

```sh
pnpm infra:up
pnpm db:migrate
```

网易云服务暂用源码启动。在 .env 配置 MUSIC_API_BASE_URL=http://127.0.0.1:3001 和 NETEASE_SOURCE_DIR，指向本机 api-enhanced 目录（当前 D:/Codes/Projects/Portfolio-Project/api-enhanced）。首次在源码目录安装依赖：

```sh
pnpm install --frozen-lockfile --prod --ignore-scripts
```

回到 POOL，在三个终端分别启动音源、Web、Socket；已运行的服务无需重复启动：

```sh
pnpm music:dev
```

```sh
pnpm dev
```

```sh
pnpm socket:dev
```

三个应用进程均由用户手动启动。访问 http://localhost:3000，BETTER_AUTH_URL 必须与浏览器站点地址一致。本地 NEXT_PUBLIC_SOCKET_URL=http://localhost:3002，Socket 绑定 127.0.0.1:3002；Web 与 Socket 共用 ROOM_INTERNAL_SECRET，ROOM_WEB_URL 指向 Web。健康检查 GET http://127.0.0.1:3002/health。浏览器均用 localhost，不混用 127.0.0.1，以便复用 Cookie。基础服务端口仅绑定本机回环地址，数据保存在独立 Docker volume；停止使用 pnpm infra:stop，再次启动使用 pnpm infra:up。

Compose 固定官方镜像摘要。拉取受网络限制时通过 .env 的 POSTGRES_IMAGE、REDIS_IMAGE 配置可访问的镜像地址并保持相同摘要，详见 [第二阶段交付](docs/开发阶段/02-基础后端与账号系统.md)。

## 账号与演示路径

1. 在 /register 填写昵称、邮箱和 8～128 位密码，注册成功直接登录。没有演示账号捷径，不发送验证邮件，也不提供邮件找回密码。
2. 在 /settings 查看真实账号、修改昵称和密码。改密需验证当前密码，成功后撤销其他会话；退出撤销当前服务端会话。会话 7 天，持续使用满一天后续期。
3. 搜索页提交网易云关键词，加载更多、播放和收藏均调用真实接口；Bilibili 当前明确未接入。个人播放按需解析临时 CDN 地址，无法取得完整资源的条目会跳过；当前上游 unblock=true 的匹配语义与目标待对齐，见第四阶段文档。
4. 喜欢页使用 PostgreSQL 收藏，支持完整网易云歌单链接导入、顺序／随机播放、队列拖拽和流式歌单分析。新账号没有旧演示账号的收藏和历史，先收藏再分析。
5. 大厅从数据库查询和创建房间；公开房可搜索名称／标签，密码房通过完整房间号查询。首次没有预置房间，创建后才通过 Socket 加入，密码错误不会写历史。
6. 房间歌单双列抽屉左侧使用真实网易云搜索，右侧管理独立持久歌单，可拖拽、导入真实喜欢、打乱和清空；无有效服务端时长歌曲不能加入。上台后按固定顺序轮播，同步播放真实音乐并聊天，当前播放者切歌、其他成员全票切歌。
7. 房主可改设置、强制下台、踢人和结束房间。同用户同房多标签页共用一名成员，最后连接离开才退房；跨房需确认。离开房间页立即停音并销毁本页连接，个人播放不自动恢复。房间不可暂停、拖动进度，自动播放受限时点击“启用声音”。
8. 真实历史每用户最多 50 条，删除只撤销本人访问记录。空房三十分钟结束，归档从结束算七天后统一清理。历史详情可生成共享总结，离页后继续并保存，成功后全员共享且不可重新生成。
9. AI 使用服务端 .env 中的 DASHSCOPE_API_KEY、DASHSCOPE_BASE_URL 和 DASHSCOPE_MODEL。默认配置 qwen3.8-flash；未填密钥返回 AI_NOT_CONFIGURED，不自动换模型。设置页只保留真实账号与音量偏好。

## 数据与替换边界

浏览器请求分为 src/lib/http.ts（Axios 实例、/api 前缀和响应拦截器）与 src/lib/api-client.ts（原始业务接口及音乐／喜欢／大厅／历史 Query hooks），不再额外包装 get／post／delete。普通业务 JSON 和网易云上游调用均使用独立 Axios 实例；Better Auth 使用官方客户端，音频播放使用 Audio，媒体流代理保留原生 fetch。浏览器请求支持取消，网易云 JSON 上游维持 15 秒总期限。

- src/server/auth/：认证核心、HTTP 入口、页面会话校验和 Redis 原子限流；核心供 Web 与 Socket 复用。
- src/server/db/、drizzle/：认证 schema、连接池与版本化迁移，包含认证四张表、liked_songs、七张房间业务表及 room_summaries；没有内部歌曲 ID 或独立歌曲表。
- src/server/music/、src/server/likes/：统一音乐适配、Redis 缓存与限流、收藏事务及导入；当前只接网易云匿名服务。
- GET /api/account：真实 Cookie 鉴权的当前用户接口，使用普通业务 JSON 响应，不接受客户端指定身份。
- /api/auth/\*：Better Auth 原生协议，客户端位于 src/lib/auth-client.ts。
- src/features/auth/session-provider.tsx：读取真实会话、同步安全投影；换号或失效时清理查询及播放。
- src/contracts/：统一曲目、安全用户、房间命令和类型化事件。AI 契约位于 ai.ts，业务 mock 已移除。
- src/server/rooms/、socket-server/index.ts：真实房间服务、串行协调、会话检查、轮播和到期清理。Web 音乐查询由独立密钥内部接口提供，Socket 不直连外部曲库。
- useRoomSession 持有页面作用域 Zustand 投影；useRoomAudio 控制实际音频加载、时间定位、取消与自动播放解锁。快照不进 Query 缓存、不做浏览器持久化。
- src/features/、src/components/ui/：桌面交互及 shadcn/ui Base UI，业务样式使用 CSS Modules。

账号与会话保存于 PostgreSQL；Redis 保存请求计数和可丢弃音乐资料缓存，不保存登录会话。浏览器不持久化密码或认证 token，旧 pool:prototype:v1:session 不参与认证。真实喜欢保存于 PostgreSQL，不将播放 URL 或歌词写入收藏；真实房间与历史保存于 PostgreSQL，在线、上台、投票及定时器在 Socket 进程内存，重启清空并等待重新上台。音量独立保存；不读取旧 pool:ai-demo:v1 或 pool:prototype:v1:data。歌单分析不入库，总结和生成状态保存于 PostgreSQL，并在房间结束满七天级联清理。

## 迁移与验证

```sh
pnpm db:generate
pnpm db:migrate
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm test:rooms
pnpm test:ai
pnpm test:music:live
pnpm format:check
pnpm build
```

db:generate 用于 schema 变更后生成 SQL，首次运行只需执行已提交迁移。认证依赖或配置变化需重新生成 schema 时使用 pnpm auth:generate，检查生成结果后再生成和执行迁移。实际密钥与密码只放在未提交的 .env。

Vitest 覆盖请求层、身份边界、个人队列、AI 输入／限额／流协议／取消及期限以及真实 React 房间会话和媒体生命周期。集成测试连接 PostgreSQL／Redis，使用可控音乐上游和真实 Socket.IO 多客户端。房间和 AI 测试在随机隔离数据库 schema 执行已提交迁移，避免启动重置影响开发房间；认证／音乐测试使用随机账号和专用 Redis 命名空间。真实音源测试需 api-enhanced 已运行；AI 集成测试使用可控兼容模型接口，不需要真实模型密钥，不代表百炼实测。测试不启动 POOL Web，不替代多浏览器实际音乐同步与听感验收。

生产 Web 构建与运行分别使用 pnpm build、pnpm start，Socket 使用 pnpm socket:start。生产构建前将 NEXT_PUBLIC_SOCKET_URL 留空，以同域 /socket.io/ 代理 Socket，保留轮询和 WebSocket 升级；该 NEXT_PUBLIC 变量在构建时注入。上线配置实际 HTTPS 的 BETTER_AUTH_URL；只有反向代理可信地覆盖 X-Forwarded-For 时才启用 AUTH_TRUST_PROXY=true。默认本地模式使用按端点共享的限流桶，忽略客户端伪造的代理 IP。

## 文档

- [第七阶段：真实歌单分析与房间总结](docs/开发阶段/07-真实歌单分析与房间总结.md)

- [第五阶段：真实一起听与房间页面整理](docs/开发阶段/05-真实一起听与房间页面整理.md)

- [第四阶段：请求层与业务查询整理](docs/开发阶段/04-请求层与业务查询整理.md)

- [第三阶段：网易云音乐与喜欢列表持久化](docs/开发阶段/03-网易云音乐与喜欢列表持久化.md)

- [第二阶段：基础后端与账号系统](docs/开发阶段/02-基础后端与账号系统.md)
- [前端原型业务范围](docs/开发阶段/01-前端交互原型.md)
- [当前交付与接入点](docs/开发阶段/01-前端原型完成情况与后端接入准备.md)
- [项目概览](docs/项目概览.md)
- [前端设计](docs/前端设计.md)
- [服务端设计](docs/服务端设计.md)
