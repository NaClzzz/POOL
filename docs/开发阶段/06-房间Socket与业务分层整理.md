# 第六阶段：房间 Socket 与业务分层整理

## 当前范围

本阶段整理房间服务端分层、前端业务请求模块及 Socket 会话代码的可读性。房间业务规则、事件契约、页面表现、数据库表和数据存储方式保持不变，没有新增控制器、命令总线或通用事件注册框架。

业务参数与契约见 [项目概览](../项目概览.md)、[服务端设计](../服务端设计.md) 和 [前端设计](../前端设计.md)；真实一起听功能范围见 [第五阶段](05-真实一起听与房间页面整理.md)，AI 接入见 [第七阶段](07-真实歌单分析与房间总结.md)。本文维护当前代码职责与验证边界。

## 1. 服务端职责

| 文件 | 当前职责 |
| --- | --- |
| `src/server/rooms/socket-server.ts` | 来源与会话校验、入口参数校验、命令确认、连接管理和 io 操作；通过当前文件内的 `sendRoomNotice` 处理广播及强退通知 |
| `src/server/rooms/service.ts` | 房间权限、密码、容量、有效期、历史上限、轮播和清理规则；`RoomService` 自行持有内部音乐请求客户端，保留 notify 回调 |
| `src/server/rooms/repository.ts` | 数据库查询、用户行锁，以及创建、加入、退出、设置、归档和重启重置等持久化操作与事务 |
| `src/server/rooms/keyed-serial.ts` | 按稳定键序串行协调异步操作，失败后释放键，退出前排空在途任务 |
| `src/server/rooms/handlers.ts` | 大厅、创建及历史的五个 HTTP 入口，复用鉴权与统一响应边界，再调用 Service |
| `src/server/http/validation.ts` | 音乐、喜欢和房间共用的 `paginationSchema`，保留原有默认值及上限 |

Socket 入口使用 `new RoomService(sendRoomNotice)`。`resolveTrack` 在 Service 内调用 Web 的内部音乐接口，外部曲库请求、缓存和上游预算仍集中于 Web 进程；播放地址不入库、不广播。

密码校验、有效房间判断、历史有效期和每人最多五十条历史等规则由 Service 决定。需要并发协调的创建判断和历史淘汰回调仍在 Repository 的用户行锁事务内执行，避免将业务判断移到锁外。大厅查询由 Service 提供筛选策略，Repository 在数据库筛选后分页。

HTTP Route 只转发至以下 handler，不直接调用 Repository：

| 接口 | Handler |
| --- | --- |
| `GET /api/rooms` | `listRoomsHandler` |
| `POST /api/rooms` | `createRoomHandler` |
| `GET /api/room-history` | `listRoomHistoryHandler` |
| `GET /api/room-history/[roomId]` | `getRoomHistoryHandler` |
| `DELETE /api/room-history/[roomId]` | `deleteRoomHistoryHandler` |

公共分页仍在各请求入口解析一次：offset 默认 0，limit 默认 20，单次最多 500 条。

## 2. RoomService 命令入口

`execute()` 保留为 Socket 命令的统一入口，依次完成用户串行协调、目标房间确定、相关房间串行协调、状态加载、加入／切换特殊处理、当前连接成员校验、离开处理及业务分发。

业务分发使用当前方法内的 `switch`：

- `room:sync` 明确为空业务分支，继续执行末尾原有广播和完整快照返回，不额外修改房间业务状态。
- 上下台、聊天、投票、媒体错误、设置及踢人调用现有类内私有方法；直接切歌保留分支内的播放者校验和推进调用。
- 歌单 add、remove、reorder、shuffle、clear、import-liked 逐项列出，共用现有 `playlistCommand`，不依赖事件名前缀识别。
- 加入／切换、离开及解散保持原有提前返回路径；导入结果仍附带实际统计。
- 普通成功命令仍按原策略广播公共状态并返回本人完整快照，没有新增第二套分发机制或改变广播协议。

事件和参数继续使用共享 `RoomCommands`；泛型不能随分支收窄的载荷使用对应事件的明确类型断言，不使用 `any` 或额外的复杂类型框架。

## 3. 前端 Socket 会话

`src/features/room/use-room-session.ts` 仍是页面作用域连接与状态入口。Socket 实例由 `socketRef` 持有，密码由 `passwordRef` 持有；房间实时投影使用当前 hook 内的 Zustand store，不持久化，也不复制到 Query 缓存。

### 事件回调与注册

七个回调定义在所属 effect 内，事件注册集中放置，未为这些回调额外增加 `useCallback` 或拆分文件：

| 事件 | 回调 |
| --- | --- |
| `connect` | `handleConnect` |
| `disconnect` | `handleDisconnect` |
| `connect_error` | `handleConnectError` |
| `room:state` | `handleRoomState` |
| `room:message` | `handleMessage` |
| `user:room-playlist` | `handlePlaylist` |
| `room:forced-leave` | `handleForcedLeave` |

消息仍按房间身份和消息 ID 校验、去重，保留最近两百条；私有歌单通过独立事件更新。强退只处理对应房间或会话失效通知。

### 超时同步

加入与普通命令的 `ACK_TIMEOUT` 恢复共用 `syncRoom(socket, freshJoin)`：只发送一次 `room:sync`，不重新发送原来的加入或写命令，不进行循环重试。

| 场景 | 快照处理与附加动作 |
| --- | --- |
| 加入超时 | 记录同步请求起止时间，校准服务器时间；以 `freshJoin=true` 应用快照，清除切房确认状态并刷新当前用户历史查询 |
| 普通命令超时 | 按普通快照规则应用，保留原时钟偏移，不额外刷新历史查询 |

两种路径应用响应前都检查 Socket 实例仍是当前连接，并要求响应包含快照。同步失败保留原来的加入错误或命令错误，不用后续同步错误覆盖原提示。

### 快照检查

`applySnapshot` 集中检查房间身份、播放版本和状态修订号。普通快照拒绝较旧的播放版本或 revision；`freshJoin` 保留首次加入及重连的语义，允许接收服务重启后重新建立的状态。

公共 `room:state` 必须已有完整快照才能合并，不能据此构造首次加入状态。回调合并公共字段并保留本人歌单和聊天，再交给 `applySnapshot` 检查，避免两处重复维护版本规则。

effect 的连接生命周期和清理方式保持一致：离页或换号先使当前连接引用失效，按原方式发送离开、移除监听并断开连接，清理凭据和实时投影，停止房间音频并刷新相关查询。加入成功时暂停个人播放，退出后不自动恢复个人播放；晚到响应不能重新启用旧连接的播放。

## 4. 前端请求与共享类型

```text
src/lib/
├─ http.ts             # Axios 实例、响应边界和集中错误转换
├─ api-client.ts       # 业务 API 与 hooks 的统一导出，页面导入方式保持不变
└─ api/
   ├─ music.ts         # musicApi、音乐搜索及歌词 hooks
   ├─ likes.ts         # likesApi、收藏查询与 mutations
   ├─ rooms.ts         # roomsApi、大厅、创建及历史 hooks
   └─ types.ts         # 共用 MutationSuccessOptions
```

`MutationSuccessOptions` 表达业务 mutation 可选的界面成功回调，不再使用收藏专属命名。各 hook 保留原有缓存刷新顺序和换号隔离处理。

房间子组件共用的 `RoomCommand` 位于 `src/features/room/types.ts`；其他组件不再反向引用成员组件获取类型。普通 HTTP 继续使用 Axios，Socket 使用独立命令确认和事件订阅。

## 5. 已完成验证与边界

代码整理已完成以下验证，本次文档编写只核对代码和引用，未重复运行测试：

- 类型检查、ESLint、Prettier 检查通过。
- 86 项单元测试通过；会话测试覆盖首次公共广播不能建快照、公共状态保留私有数据、重渲染不重连、旧版本拒绝、重连接受重建状态、加入超时校时及清除切房意图、普通命令超时不重放、同步失败不循环重试、换号或离页后的晚到响应失效。
- 12 项真实 Socket.IO／PostgreSQL／Redis 房间集成测试通过，覆盖鉴权、密码与容量、多连接、切房、房主权限、轮播投票、聊天限流、导入排序、歌单并发、历史上限、过期清理及重启重置。
- 房间集成使用临时隔离容器和随机数据库 schema，可控 HTTP 上游提供音乐资料；测试容器已清理，未启动 POOL 应用或现有开发服务。

最近一次 Socket 可读性整理未重新运行生产构建、真实网易云 live 测试或浏览器人工验收。协议与受控媒体测试不替代多浏览器真实听感验证；真实 AI、Go／Bilibili 接入不属于本阶段交付。
