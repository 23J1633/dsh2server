# dsh2server

把本机的 **DeepSeek Harness（dsh）** 连接到一台中转服务器：服务器上能看到这台机器的**实时工作状态、全部工作目录和会话活动**，并能对它下发操作（**新命令、中断、暂停/恢复、审批应答、任务终止、会话管理**）。

- **dsh 主动连出**，服务器不需要访问你的电脑，不需要端口映射，不需要内网穿透。
- **服务器只是中转**：协议不要求服务器保存任何会话内容；唯一需要落盘的是你自己的机器白名单。
- **每台机器一个唯一 key**，插件首次启动自动生成，服务器用"多 key 白名单"管理任意多台电脑，撤销某台机器不影响其它机器。
- **`http://` 与 `https://` 同等支持，并且可以同时连多个端点**：例如内网一台 `http://` 中转给本地控制台用，公网一台 `https://` 供远程访问。每条连接互相独立，一个端点掉线不影响其它端点。
- **零运行时依赖**：纯 ESM JavaScript，无需构建，使用 Node 内置的 `fetch` / `WebSocket`。
- **一套固定 API**：WebSocket 与 HTTP 长轮询两种载体共享同一套 JSON 帧，后端用任何语言/框架实现都可以。完整规范见 [`docs/API.md`](docs/API.md)。

---

## 目录

- [快速开始](#快速开始)
- [安装](#安装)
- [配置](#配置)
- [图形化配置（dsh Web GUI）](#图形化配置dsh-web-gui)
- [实例 Key 与配对](#实例-key-与配对)
- [服务器端](#服务器端)
- [远程能做什么](#远程能做什么)
- [能力依赖](#能力依赖)
- [工作原理](#工作原理)
- [目录结构](#目录结构)
- [开发与测试](#开发与测试)
- [安全须知](#安全须知)
- [常见问题](#常见问题)

---

## 快速开始

```bash
# ① 装进某个 dsh profile（本例用 web）
dsh plugin --profile web add /path/to/dsh2server

# ② 在该 profile 的 cordis.patch.yml 里把 endpoint 填成你的服务器地址
#    （或者直接改 bundle 自带的那一行；也可以设置环境变量 DSH2SERVER_ENDPOINT）
#      endpoint: 'https://example.com/dsh-api'

# ③ 启动，日志里会打印本机专属 key
dsh web
#   [dsh2server] instance key: dshk_xxxxxxxxxxxxxxxxxxxx   ← 复制它

# ④ 把这个 key 登记到你的服务器（示例用本仓库的参考实现）
curl -X POST https://example.com/dsh-api/keys \
     -H 'content-type: application/json' \
     -H 'x-admin-key: <管理密钥>' \
     -d '{"key":"dshk_xxxxxxxxxxxxxxxxxxxx","label":"我的笔记本"}'
```

登记完成后（最多 60 秒内）机器就会上线。用本仓库的参考服务器可以立刻验证：

```bash
node examples/server.js --port 8787 --keys ./examples/keys.json
# 然后在插件里把 endpoint 填成 http://127.0.0.1:8787/dsh-api
curl http://127.0.0.1:8787/dsh-api/instances            # 看在线机器
```

---

## 安装

它是一个标准的 dsh **bundle**（`package.json` 里声明 `dsh.bundle.patch`），因此用 dsh 自带的插件管理安装即可：

```bash
# 从本地目录安装（开发时最方便；pnpm 会做 link）
dsh plugin --profile <name> add /path/to/dsh2server

# 从 GitHub 安装（需要 Node 侧允许该包的构建脚本；本包无需构建，因此不会被拦）
dsh plugin --profile <name> add github:<you>/dsh2server

# 从 tarball 安装
pnpm pack && dsh plugin --profile <name> add ./dsh2server-0.1.0.tgz
```

安装后：

```bash
dsh plugin --profile <name> list           # 确认已加入 dsh.profile.bundles
dsh --profile <name> --dump-config         # 能看到 "# == dsh2server" 这一层
```

卸载：

```bash
dsh plugin --profile <name> remove dsh2server
```

### 手工安装（等效于 `dsh plugin add`）

在 profile 目录（`$DSH_HOME/profiles/<name>`）里：

1. `cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: dsh2server
         name: 'dsh2server'
         config:
           endpoint: 'https://example.com/dsh-api'
   ```

2. `package.json` 里加上依赖与 bundle 列表：

   ```json
   {
     "dependencies": { "dsh2server": "link:/path/to/dsh2server" },
     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh2server"] } }
   }
   ```

3. 在 profile 目录执行 `pnpm install`。

---

## 配置

### 唯一必填项

```yaml
endpoint: 'https://example.com/dsh-api'
```

`endpoint` 是**服务器 API 的基地址**。插件由它推导出 `…/ws`、`…/events`、`…/inbox`（规则见 [`docs/API.md` §2.1](docs/API.md#21-端点推导规则)）。

它接受**单个 URL、URL 列表或逗号分隔字符串**，并且每个 URL 的协议（`http` / `https`）可以任意混用：

```yaml
# 单个端点（最常见）
endpoint: 'https://example.com/dsh-api'

# 多个端点：内网 + 公网同时在线
endpoint:
  - 'https://example.com/dsh-api'      # 公网可达
  - 'http://10.0.0.5:8787/dsh-api'     # 局域网内的中转，给本机控制台用
```

同一个实例对每个端点使用**同一把 key**，多个服务器看到的是同一个 `instanceId` 和同一套事件序号；每条连接各自独立重连、独立订阅，一个端点不可达或被吊销都不会影响其它端点。

空着不填时，插件保持**加载但完全空闲**，不会发任何网络请求，并在日志里提示如何配置。也可以用环境变量代替：

```bash
DSH2SERVER_ENDPOINT=https://example.com/dsh-api        # 或用逗号分隔多个
DSH2SERVER_KEY=<可选：固定 key，不落盘>
```

#### 关于 HTTP 与 HTTPS

- **两种协议都完整支持**，不强制 TLS。使用 `http://` 时插件会在启动日志里明确告警（key 与全部会话流量都是明文），并在 `instance.info` 的 `connection.insecure` 中持续标记。
- 私有 CA 签发的证书：`NODE_EXTRA_CA_CERTS=/path/to/ca.pem`（推荐做法）。
- 自签名证书：仅在你已经信任该网络时使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- 公司代理阻断 WebSocket 升级时，把 `transport` 固定为 `'http'`。

### 常用可选配置

完整列表（含默认值）见 [`cordis.patch.yml`](cordis.patch.yml)。最常改的几个：

| 配置 | 默认 | 说明 |
|---|---|---|
| `key` | `''` | 留空 = 自动生成并保存在本机；填写 = 使用该 key 且不落盘 |
| `keyFile` | `''` | 身份文件路径，默认 `<DSH_HOME>/dsh2server/identity.json` |
| `authMode` | `hello` | key 的传递方式：`hello` / `header` / `query` |
| `transport` | `auto` | `auto`（先 WebSocket 再回退 HTTP）/ `ws` / `http` |
| `autoSubscribeSessions` | `running` | 自动推送哪些会话的逐条事件：`none` / `running` / `all` |
| `forwardApprovals` | `false` | 是否把**工具调用审批**转发到服务器等待远程批准 |
| `forwardQuestions` | `false` | 是否把**结构化提问**转发到服务器 |
| `allowRemotePrompt` | `true` | 是否允许远程下发新命令 |
| `allowRemoteControl` | `true` | 是否允许远程中断/暂停/切策略/轮换 key |
| `allowRemoteCommand` | `true` | 是否允许远程执行斜杠命令（如 `/compact`） |
| `allowedCwdPrefixes` | `[]` | 非空时，只有工作目录匹配这些前缀的会话才可见/可控 |
| `logLevel` | `info` | `silent` / `error` / `warn` / `info` / `debug` |

> 配置错误会在**加载阶段**直接失败，并给出精确到字段的错误信息（例如 `transport: must be one of auto | ws | http`）。

---

## 图形化配置（dsh Web GUI）

装好之后，dsh 的网页界面里会**自动多出一个标签页**：

```
设置 → 插件 → dsh2server
```

它提供：

| 区域 | 能做什么 |
|---|---|
| 服务器 API 端点 | 多行文本框，一行一个 URL（`http` / `https` 可混用）。**保存后立即生效，无需重启 dsh** |
| 传输方式 | `auto` / `ws` / `http` 下拉（PHP 后端选 `http`） |
| 本机实例 Key | 指纹展示、`显示` 完整 key、**`复制 Key`** 一键复制、`复制登记命令`（生成可直接执行的 curl）、`轮换 Key` |
| 连接状态 | 每条链路的实时状态（已连接 / 未连接 / 被拒绝）与拒绝原因 |
| 远程权限 | `allowRemotePrompt` / `allowRemoteControl` / `forwardApprovals` 开关 |

### 它是怎么出现的（对使用者完全透明）

标签页是**这个包自带的前端半边**，不是对 dsh 的改动：

- 包在自己的 `package.json` 里声明了 `dsh.client`（`exports["./client"]` → `lib/client.js`），dsh 的**客户端模块系统**会自动扫描已启用的 Loader 条目，把每个声明了 `dsh.client` 的包的浏览器产物送到页面；
- 浏览器半边只往 dsh **公开的插槽** `settings.plugins.tab` 里注册一行（和内置的「插件配置」标签用的是同一个扩展点），并自带样式与数据获取；
- 数据通过本包自己注册在 Connection 共享通道上的 `/api/dsh2server/*` 路由取得——因此天然带有 dsh 的 Host/Origin 校验与浏览器会话认证。

结论：**任何人 `dsh plugin add dsh2server` 之后，打开网页就能看到这个标签页**，不需要改 dsh、不需要额外步骤，也不需要作者本机有什么特殊配置。前端产物零外部依赖（只用 shell 平台表里的 `react`，所以连 `dsh.client.external` 都不用声明，不会因为别人组合里缺某个插件而失败）。

### 配置的优先级

网页里改过的项写入 **`<DSH_HOME>/dsh2server/config.json`**，它**逐键覆盖** `cordis.yml` 里的同名项：

```
schema 默认值  <  cordis.yml 的 loader 行  <  config.json（网页设置）
```

点「恢复配置文件的值」会把该键从网页层删掉，重新继承 `cordis.yml` 的值。标签页上带「·由网页设置」标记的字段就是被覆盖的项。

> `key`、`allowedCwdPrefixes` 这类部署级/安全级配置**不在**网页可编辑范围内，仍然只由 `cordis.yml` 决定。

---

## 实例 Key 与配对

### 每台机器一个 key

- 首次启动时插件用 CSPRNG 生成 `dshk_` + 43 字符（256 bit 熵）的唯一 key。
- key 保存在**本机** `<DSH_HOME>/dsh2server/identity.json`（`0600`），**不会**上传到服务器。
- 启动日志里会打印一次完整 key；也可以随时用脚本读取：

  ```bash
  node scripts/show-key.js            # 人读格式
  node scripts/show-key.js --json     # 机器可读
  ```

### 服务器侧多 key 白名单

服务器维护"key → 机器"的映射（示例 `examples/keys.json`）：

```json
{
  "keys": [
    { "key": "dshk_AAAA…", "label": "办公室台式机" },
    { "key": "dshk_BBBB…", "label": "笔记本" }
  ]
}
```

语义：

- 一个 key 只能访问它自己那台机器，**多机器之间完全隔离**。
- **吊销 = 删除 key**：该机器下次重连（≤60s）被拒，其它机器不受影响。
- **轮换**：对机器调用 `instance.rotateKey`，把返回的新 key 登记进白名单、删掉旧 key。
- 服务器只显示 key 指纹（`dshk_AbCdEf…9xYz`），不要把完整 key 回显到界面。

### 配对流程

```text
① dsh 启动 → 日志打印 key（或 node scripts/show-key.js 读取）
② 把 key 登记进服务器白名单
③ 机器自动上线（GET /instances 可见）
```

机器**离线后再上线不需要重新配对**——key 是持久的。

---

## 服务器端

后端需要实现的一切都在 **[`docs/API.md`](docs/API.md)**：

- 两种传输的端点约定与握手细节
- 全部帧（envelope）字段
- 订阅模型与全部事件（`session/event`、`session/status`、`session/assistant-stream` …）
- 全部远程方法（参数 / 返回 / 错误码）
- 错误码表、序号补发与断线重连语义
- 后端实现清单与安全建议

本仓库还提供一个**零依赖、可直接运行的参考实现**（同时被测试用作真实服务端）：

```bash
# 只用 HTTP
node examples/server.js --port 8787 --keys ./examples/keys.json

# HTTP 与 HTTPS 同时监听（同一份 key 白名单、同一份实例表）
node examples/server.js --port 8787 --tls-port 8443 \
     --tls-cert ./cert.pem --tls-key ./key.pem --keys ./examples/keys.json
```

它实现了 WebSocket + HTTP 长轮询两种载体、HTTP 与 HTTPS 双监听、多 key 白名单、内存事件环、以及一组管理接口：

```
GET    /dsh-api/instances                      在线机器
GET    /dsh-api/instances/:id/events           最近事件（仅内存）
POST   /dsh-api/instances/:id/request          下发任意操作
POST   /dsh-api/instances/:id/subscribe        调整订阅
GET    /dsh-api/keys  / POST /dsh-api/keys     查看 / 登记 key
POST   /dsh-api/keys/remove                    吊销 key
```

详见 [`examples/README.md`](examples/README.md)。

### PHP 后端（带内置网页测试台）

不想装 Node 也可以直接用 PHP：[`php/dsh-relay.php`](php/dsh-relay.php) 是一个**单文件、零依赖**的中转服务器，
并且自带一个完整的网页调试台——配对、看在线机器、拉会话与工作目录、下发命令、中断/暂停/恢复、
任务与目标、审批应答、事件流实时刷新，以及"一键自检"逐条验收整条链路。

```bash
php -S 127.0.0.1:8080 php/dsh-relay.php      # Windows: D:\xampp\php\php.exe -S 127.0.0.1:8080 php/dsh-relay.php
# 然后浏览器打开 http://127.0.0.1:8080/
```

插件侧配置：

```yaml
endpoint: 'http://127.0.0.1:8080/dsh-api'
transport: 'http'        # PHP 无法升级 WebSocket；写 auto 也会自动回退到 HTTP 长轮询
```

> PHP 的 `php -S` 与 mod_php 都无法把 HTTP 请求升级为 WebSocket，因此该实现走协议允许的
> **HTTP 长轮询**载体——功能与 WebSocket 完全一致，只是延迟略高。需要真正的 WebSocket 时用
> Node 参考实现或 Workerman / Ratchet / Swoole。

细节见 [`php/README.md`](php/README.md)。

---

## 远程能做什么

### 看状态

- `session.list` — 所有会话，带 `cwd`（工作目录）、`running`（是否在干活）、最后活动时间
- `workspace.list` — 这台机器上的全部工作目录及其会话
- `session.get` — 单个会话的详细状态：模型、待处理队列、待办清单（todos）、目标（goal）、审批策略、暂停状态
- `session/status`、`session/activity`、`session/event`、`session/assistant-stream` 事件流 —— 实时看到每一轮、每一步、每次工具调用和逐 token 输出
- `job.list` / `job.read` — 后台任务及其输出
- `goal.get` — 长期目标的阶段与轮次

### 下操作

| 操作 | 方法 |
|---|---|
| 下发新命令 | `session.prompt`（`mode: queue`） |
| 给正在跑的那一轮追加指示 | `session.prompt`（`mode: steer`） |
| 中断当前执行（保留排队） | `session.interrupt` |
| 中止并丢弃排队 | `session.cancel` |
| **暂停运行** | `session.pause` |
| 恢复并放行暂停期间排队的命令 | `session.resume` |
| 新建会话（指定工作目录） | `session.create` |
| 读取历史 / 全文检索 | `session.history` / `session.search` |
| 改名 / 分叉 | `session.rename` / `session.fork` |
| 切换模型 | `session.selectModel` |
| 编辑/删除排队中的消息 | `session.queueUpdate` |
| 切换审批策略（`ask` / `never`） | `session.approvalPolicy` |
| 终止后台任务 | `job.kill` |
| 暂停/恢复/完成目标 | `goal.pause` / `goal.resume` / `goal.complete` |
| 执行斜杠命令 | `command.run` |
| 应答审批与提问 | `approval.respond` / `question.answer` |
| 读取/轮换本机 key | `instance.key` / `instance.rotateKey` |

**"暂停运行"的实现语义**（值得后端注意）：

1. 立即中止当前 turn（已排队的工作保留）；
2. 如果该会话有 active 的 goal，一并暂停（否则目标轮次驱动会立刻开新一轮）；
3. 暂停期间到达的 `session.prompt` 被**扣在插件内存里排队**，返回 `deferred: true`；
4. `session.resume` 时按顺序放行，并在 `session/resumed` 事件里报告 `delivered` 数量。

排队上限由 `pauseQueueLimit` 控制；队满时返回 `conflict`（`retryable: true`），服务器应稍后重试。

---

## 能力依赖

插件**不强制依赖**任何 dsh 服务：它用 `ctx.get(...)` 探测现有服务，并把真实可用的能力写进 `hello.capabilities`。因此最小组合也能连上并汇报状态，只是方法会少一些。

| 需要的能力 | 由谁提供 | 缺失时 |
|---|---|---|
| 会话/代理核心 | `dsh-base`（总是存在） | 插件仍会加载，但几乎无事可做 |
| `sessionController` | `dsh-web-app` 组合（`dsh web`） | 会话列表退化为"仅活动会话"，且历史/搜索/改名/选模型不可用 |
| `sessionPersistence` | `dsh-base` | 冷会话不可见 |
| `workspaceRegistry` | web 组合 | `workspace.list` 退化为按 `cwd` 聚合 |
| `jobs` / `goals` / `commands` | `dsh-base` | 对应方法返回 `capability_unavailable` |
| `approval` | `dsh-base` | 审批策略不可远程切换 |
| `userQuestions` | 通常由 UI 组合提供 | 远程回答提问不可用 |

日常使用 `dsh web` 时上述能力全部具备。

---

## 工作原理

```
┌───────────────────────────── 本机 ─────────────────────────────┐
│  dsh 进程                                                      │
│   ├─ agent / session / jobs / goal / approval / commands …     │
│   └─ dsh2server 插件                                        │
│        ├─ lib/identity.js   本机唯一 key（本地持久化）           │
│        ├─ lib/host.js       能力探测与宿主适配（可选服务降级）    │
│        ├─ lib/forward.js    dsh 事件 → 协议事件                 │
│        ├─ lib/ops/*         入站方法 → dsh 操作                 │
│        ├─ lib/gate.js       暂停/恢复的状态机与排队             │
│        ├─ lib/bridge.js     实例级共享状态（身份/序号/缓冲/方法） │
│        └─ lib/link.js + transport/*   每条端点一条独立链路       │
└───────┬──────────────────────────────────────┬─────────────────┘
        │ 出站 wss:// (公网)                    │ 出站 ws:// (内网)
        ▼                                       ▼
  https 中转服务器                        http 中转服务器
  （纯中转，可无状态）                     （纯中转，可无状态）
```

> 一条链路可以同时是 WebSocket 或 HTTP 长轮询，也可以是 TLS 或明文；每个端点各有一套，互不影响。

设计要点：

- **服务器可无状态**：所有状态都能被重新推送。断线时插件在内存环形缓冲里保留最近 `bufferSize` 条事件，重连后按水位补发；补发窗口不够时会发 `bridge/resync`，服务器重新拉全量即可。
- **不订阅就不序列化**：事件按 topic 订阅，没订阅的流完全不走 JSON 编码，空闲链接开销接近零。
- **永不阻塞本机**：所有入站方法都有超时与并发上限；所有宿主调用都被包裹，异常只会变成一个协议错误，不会影响 dsh 本体。
- **审批转发是可选的、且不抢占本机**：远程不回答或超时，会自动交回本机 UI 处理，绝不会把本地会话卡死。

---

## 目录结构

```
dsh2server/
├── package.json            # bundle 清单（dsh.bundle.patch）+ 浏览器半边声明（dsh.client）
├── cordis.patch.yml        # 装载行 + 全部配置项与默认值
├── index.js                # 插件入口（name / Config / apply）
├── lib/
│   ├── client.js           # 浏览器半边：设置页里的 dsh2server 标签（手写 lazy-CJS 产物）
│   ├── host-ui.js          # 网页控制台的宿主路由（/api/dsh2server/*，走 Connection 鉴权）
│   ├── settings-store.js   # 配置分层与持久化（cordis.yml ← 网页设置）
│   ├── bridge.js           # 实例级状态：身份、事件序号、环形缓冲、方法表
│   ├── link.js             # 单端点连接：载体、订阅、心跳、退避（可多条并存）
│   ├── transport/          # WebSocket 与 HTTP 长轮询载体
│   ├── ops/                # 全部入站方法
│   ├── forward.js          # 宿主事件转发（含审批/提问应答）
│   ├── host.js             # 能力探测与宿主适配
│   ├── gate.js             # 暂停/恢复状态机
│   ├── identity.js         # 每机唯一 key
│   ├── protocol.js         # 帧与错误码
│   ├── config.js           # 配置校验（Standard Schema）
│   ├── buffer.js           # 事件环形缓冲与补发
│   └── util.js / log.js / version.js
├── scripts/show-key.js     # 打印本机 key
├── examples/               # 参考后端（Node，可运行）+ 极简 WebSocket 服务端
├── php/                    # 参考后端（PHP 单文件）+ 内置网页测试台
├── docs/API.md             # ★ 服务器接口规范
└── test/                   # 单元 + 端到端 + 多端点/双协议 + PHP + 真实 Cordis 集成测试
```

---

## 开发与测试

```bash
npm test                        # 全部测试（单元、端到端、多端点/双协议、PHP 后端、真实 Cordis 集成）
node --test test/unit.test.js
node --test test/e2e.test.js
node --test test/multi-endpoint.test.js
node --test test/php-relay.test.js   # 找不到 PHP 时自动跳过（可用 PHP_BIN 指定）
```

测试覆盖：

- **单元**：配置校验（含单端点/列表/逗号分隔）、协议帧、key 生成/持久化/轮换、环形缓冲补发窗口、暂停状态机、方法分发（含权限开关、目录白名单、能力降级）
- **端到端**：真实 `Bridge` 对真实参考服务器 —— key 握手、远程操作、事件流式转发、订阅/退订、HTTP 长轮询回退、断线重连、**多机器多 key 管理**、key 轮换与吊销
- **多端点 / 双协议**：一个中转同时提供 HTTP 与 HTTPS、同一台机器同时连多个端点并把状态镜像给所有服务器、订阅按服务器隔离、某个端点不可达不影响其它端点
- **网页控制台**：用**真实的 dsh Connection 服务**装载插件并驱动 `/api/dsh2server/*`——设置端点会真的把连接切到新服务器、非法写入被拒绝且不生效、重置回落到配置文件、轮换 key 会落盘；浏览器半边用带 Hook 调度器的最小 React **真实渲染**并点击每个按钮
- **PHP 后端**：用真实的插件客户端跑通 `php/dsh-relay.php` —— 握手、管理接口请求/响应、下发命令、暂停闸门、事件转发、未知 key 的配对流程、内置测试台的 HTML 与前端脚本
- **Cordis 集成**：把插件真正装载进一个 Cordis `Context`，验证 Standard Schema 配置在加载期生效、`apply`/`ctx.effect` 生命周期与卸载清理（找不到本机 dsh 安装时自动跳过）

调试时把 `logLevel` 设为 `debug`，可以看到每次请求/响应的收发。

---

## 安全须知

1. **优先用 HTTPS/WSS**。key 等同于这台机器的登录凭据。`http://` 完整支持（内网/回环中转很常见），但会明文传输 key 与会话内容——插件启动时会告警，并在 `connection.insecure` 里持续标记，请自行确认网络可信。
2. **服务器只存 key**。协议不要求存会话内容；一旦存储，泄露影响远大于 key 泄露。
3. **按需收紧插件权限**：`allowedCwdPrefixes` 可以把远程操作限制在指定目录树内；`allowRemotePrompt` / `allowRemoteCommand` / `allowRemoteControl` 可以分级关闭。
4. **审批转发默认关闭**。打开 `forwardApprovals` 等于"服务器上的人可以批准本机的工具调用"，请确认服务器的可信边界后再开。
5. **key 吊销是即时的**：删除服务器上的 key，该机器下一次重连就会被拒绝。
6. **多端点 = 多个信任边界**：同时连多个服务器时，任一服务器的持有者都拥有等同的远程操作能力。只配置你确实要授权的端点。

---

## 常见问题

**Q：插件加载了但日志说 idle，怎么办？**
没填 `endpoint`。填上服务器地址（或设置 `DSH2SERVER_ENDPOINT`）后重启 dsh。

**Q：日志出现 "unknown instance key"，怎么修？**
你的机器还没被服务器登记（或 key 被删了）。运行 `node scripts/show-key.js` 取 key，登记到服务器；插件会自己重连，不必重启 dsh。

**Q：可以用 http 吗？公司内网没有证书。**
可以。`endpoint: 'http://10.0.0.5:8787/dsh-api'` 直接就能用，插件只会在启动时告警一次。要更安全又不方便办证书，可以用 `NODE_EXTRA_CA_CERTS` 指定自建 CA，或直接去掉 TLS 而只在内网暴露。

**Q：能同时连多个服务器吗？比如内网一个、公网一个。**
能。`endpoint` 写成列表即可，`http` 和 `https` 可以混用。每条连接互相独立：断线、重连、订阅、补发都是分开的；而 instanceId、key 和事件序号是共享的，所以两台服务器看到的是同一台机器的同一份状态。

**Q：key 文件丢了会怎样？**
插件会生成新 key，服务器会把它当成一台新机器。用配置 `key` 显式固定 key（配合密钥管理系统）可以避免这种情况。

**Q：怎么确认只连我自己的服务器？**
插件只主动连出到你配置的 `endpoint` 列表，不监听任何端口，也不会连接其它地址。用 `instance.info` 可以看到 `endpoints`（配置值）、`connections`（每条链路的实时状态）与 `transport`。

**Q：服务器需要开公网端口吗？**
需要，但那只是服务器自己的入站端口；你的电脑不需要任何入站端口，也不需要内网穿透。

**Q：WebSocket 被公司代理拦了怎么办？**
把 `transport` 固定为 `'http'`，插件会走 HTTP 长轮询，功能完全一致（延迟略高）。

**Q：能同时管理多少台机器？**
没有上限——服务器侧就是一张 key 表，每台机器是独立的一条连接（或同时多条，如果它配了多个端点）。
