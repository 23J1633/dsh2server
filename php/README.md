[中文](#中文) | [English](#english)

# PHP 测试后端（含内置 HTML 测试台）

## 中文

`dsh-relay.php` 是一个**单文件、零依赖**的 PHP 中转服务器：它实现 `docs/API.md` 里的协议，
并且自带一个网页调试台，用来验证"插件 ↔ 服务器"整条链路是否通。

```
php/dsh-relay.php    中转服务器 + 测试 UI（一个文件搞定）
php/keys.example.json 安全的空白示例
php/keys.json        本机 key 白名单（运行时生成，已忽略，禁止提交）
php/data/state.json  运行时状态（最近事件环 / 待发帧 / 待回请求；可随时删除）
```

## 运行

```bash
cd php
cp keys.example.json keys.json
php -S 127.0.0.1:8080 dsh-relay.php
```

PowerShell 使用 `Copy-Item .\keys.example.json .\keys.json`。`keys.json`、`data/*.json` 与 `data/*.lock` 均已加入 `.gitignore`；它们是本机运行数据，不属于源码。

Windows 上最省事的是直接双击 **`php\start-relay.cmd`**（自动找 XAMPP 的 php、打印端点、关闭窗口即停止）。

然后浏览器打开 **http://127.0.0.1:8080/** 就是测试台。

> Windows 上用 XAMPP 的 PHP：`D:\xampp\php\php.exe -S 127.0.0.1:8080 dsh-relay.php`
> 或者把 `php/` 放进 htdocs 用 Apache 跑（并发更好，见下面的"轮询与并发"）。

### 关于"服务会不会自己没了"

中转服务器是一个**独立进程**，它和 dsh、和任何别的程序都没有关系——但你**把它挂在谁的进程树下**很关键：

- 在自己终端里跑（`start-relay.cmd` 或直接 `php -S …`）：只有关窗口 / Ctrl+C / 关机才会停；
- 由别的进程以子进程方式拉起：**那个父进程一重启，它就会被一起带走**（Windows 的进程树清理）。
  这正是"dsh 重启后 8080 打不开"最常见的原因。

所以：联调期间请自己在终端里跑着它。插件不需要它一直在线——服务器不在时插件只是按退避重连，
服务器回来后在最长 60 秒内**自己重连成功**，不需要重启 dsh。

## 让插件连上来

1. 在插件配置里把 `endpoint` 指向本服务：
   ```yaml
   endpoint: 'http://127.0.0.1:8080/dsh-api'
   transport: 'http'        # PHP 不支持 WebSocket；写 auto 也会自动回退
   ```
   > 也可以不改配置文件：dsh 网页界面 **设置 → 插件 → dsh2server** 里直接填端点、传输方式选 `http`，
   > 保存即生效；那里还有「复制 Key」，省得去翻日志。
2. 启动 dsh。插件首次启动会打印自己的实例 key：
   ```
   [dsh2server] instance key: dshk_xxxxxxxx
   ```
3. 在测试台 ① 面板把 key 粘进「登记」框（或者如果插件已经尝试连接过，它会被记进
   「等待配对」，点一下「允许」即可）。
4. 几秒内 ② 面板就会出现这台机器，随后所有操作都能点了。

> **关于 WebSocket**：PHP 的 `php -S` 与 mod_php 都无法把 HTTP 请求升级成 WebSocket，
> 所以本实现走协议允许的 **HTTP 长轮询**载体（`POST /dsh-api/events` + `GET /dsh-api/inbox`）。
> 功能与 WebSocket 完全一致，只是延迟略高。插件请求 `GET /dsh-api/ws` 时会收到
> `426 websocket_unsupported`，并在 `transport: auto` 下自动回退。
> 需要真正的 WebSocket，请用 Node 参考实现（`examples/server.js`）或 Workerman / Ratchet / Swoole。

## 测试台能做什么

| 面板 | 用途 |
|---|---|
| ① 配对 / Key 白名单 | 查看待配对机器并一键登记、手动登记 key、删除（= 吊销）、开启"自动接受"（仅测试用） |
| ② 在线机器 | 每台机器的 instanceId、传输方式、能力数量、最后活动时间、事件数；点击选中 |
| ③ 事件流 | 实时显示插件上报的事件（`session/status`、`session/event`、`session/assistant-stream` …），可过滤全部/仅关键 |
| ④ 操作面板 | 状态（instance.info/health）、会话列表与工作目录、下发命令、中断/取消/暂停/恢复、审批策略、新建会话/改名/搜索、任务、目标、斜杠命令、任意方法的原始调用 |
| ⑤ 审批 / 提问 | 插件开启 `forwardApprovals` / `forwardQuestions` 时，在这里远程「允许一次 / 拒绝 / 作答」 |
| ⑥ 一键自检 | 依次验证：握手 → 能力协商 → 链路信息 → 会话列表 → 工作目录 → 会话详情 → 下发命令 → 中断，并逐条列出 ✅/❌ |

「一键自检」会向所选会话**发送一条真实消息**（内容形如 `[自检] 12:34:56`）来验证下发通道，
发送前会弹窗确认；它会留在会话记录里，自检结束后你可以直接中断它。

## API 一览

数据面（插件用）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/dsh-api/events` | 插件上行（批量帧）；未授权的 key 会返回 401 并被记入待配对 |
| `GET` | `/dsh-api/inbox` | 插件下行（长轮询） |
| `GET` | `/dsh-api/ws` | 返回 426，明确告知 PHP 不支持 WebSocket |

管理面（测试台用）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/dsh-api/` | 协议信息与在线统计 |
| `GET` | `/dsh-api/keys` · `POST` `/keys` · `POST` `/keys/remove` | key 白名单 |
| `GET` | `/dsh-api/pending` · `POST` `/pending/allow` · `POST` `/pending/auto` | 配对 |
| `GET` | `/dsh-api/instances` | 在线机器 |
| `GET` | `/dsh-api/instances/{id}/events?since=&limit=` | 最近事件（内存/state.json，默认留 300 条） |
| `POST` | `/dsh-api/instances/{id}/request` | 下发操作，`{ "method": "...", "params": {...} }`，**立即返回 id** |
| `GET` | `/dsh-api/instances/{id}/response?id=` | 轮询该操作的响应 |
| `POST` | `/dsh-api/instances/{id}/subscribe` | 调整订阅 `{ topics?, sessions?, assistantStream? }` |
| `POST` | `/dsh-api/instances/{id}/forget` | 清掉这台机器的内存状态（不动 key） |
| `POST` | `/dsh-api/admin/clear` | 清空全部中转状态 |

> `request` 之所以"立即返回 + 轮询"，是因为 `php -S` 是单进程串行的：如果在那里阻塞等响应，
> 就会卡住插件拉取待发帧的 `/inbox` 请求，直接死锁。用 Apache 多进程也一样安全。

```bash
# 用 curl 手动玩一遍
BASE=http://127.0.0.1:8080/dsh-api
curl -s $BASE/instances | jq
ID=$(curl -s $BASE/instances | jq -r '.instances[0].instanceId')
curl -s -X POST $BASE/instances/$ID/request -H 'content-type: application/json' \
     -d '{"method":"session.list","params":{}}' | jq
# → {"queued":true,"id":"req-xxxx","method":"session.list"}
curl -s "$BASE/instances/$ID/response?id=req-xxxx" | jq
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_RELAY_BASE` | `/dsh-api` | API 路径前缀 |
| `DSH_RELAY_KEYS` | `<本目录>/keys.json` | key 白名单文件 |
| `DSH_RELAY_DATA` | `<本目录>/data` | 状态目录（可随时删除，插件会重新上报） |
| `DSH_RELAY_ADMIN_KEY` | 空 | 设置后管理接口需要 `x-admin-key`（测试台会提示输入一次并记住） |
| `DSH_RELAY_POLL_MS` | cli-server 400 / 其他 15000 | 单次长轮询上限；`php -S` 下必须短，否则会卡住其它请求 |
| `DSH_RELAY_EVENT_LIMIT` | 300 | 每台机器保留的最近事件条数 |

### 轮询与并发

`php -S` 单进程串行处理请求，所以长轮询必须很短（默认 400ms）。想降低延迟有两个办法：

- 把 `DSH_RELAY_POLL_MS` 调到 150~200（请求更多但更跟手）；
- 用 Apache/XAMPP 挂载（多进程），然后把 `DSH_RELAY_POLL_MS` 调到 15000——这样插件
  一次挂起 15 秒，既省请求又最快收到推送。

（`PHP_CLI_SERVER_WORKERS` 在 Windows 上不可用，因此 Windows 下 `php -S` 只能串行。）

## 安全提醒

- 这是**测试后端**：状态放在 `php/data/state.json`（不含会话正文，只有最近事件环与待发帧），
  key 明文放在 `php/keys.json`。生产环境请把 key 存进数据库/密钥管理，并要求 HTTPS。
- 若旧版本曾把 `php/keys.json` 提交进 Git，单纯删除工作树文件并不能清除历史；公开仓库前必须轮换该 key，并使用历史清理工具移除旧对象。
- 管理接口默认只对"没设置 `DSH_RELAY_ADMIN_KEY`"的本地测试开放；一旦对外提供服务，
  **必须**设置 `DSH_RELAY_ADMIN_KEY`，否则任何人都能下发命令。
- 别在公网暴露 `php -S`。它没有超时保护、没有并发控制，只适合本机/内网联调。

---

## English

`dsh-relay.php` is a single-file, dependency-free PHP test relay with an embedded HTML console. It implements the protocol in `docs/API.md` and is intended for local or private-network integration testing, not production hosting.

### Run

```bash
cd php
cp keys.example.json keys.json
php -S 127.0.0.1:8787 dsh-relay.php
```

Point the plugin at `http://127.0.0.1:8787/dsh-api`. The built-in page can inspect online instances, sessions, workspaces, recent events, queue requests, send prompts, interrupt work, and answer supported interactions. The Chinese section above contains the complete endpoint and curl reference.

### Environment and concurrency

Configuration includes the listen/base URL used by the plugin, key file/data paths, administrator key, polling duration, queue limits, and recent-event retention. Set `DSH_RELAY_ADMIN_KEY` whenever management access is not strictly localhost-only. On Unix-like systems, `PHP_CLI_SERVER_WORKERS` can provide multiple workers so long polling does not block unrelated requests; it is unavailable on Windows.

The server writes lightweight runtime state under `php/data/state.json` and plaintext test keys under `php/keys.json`. Session transcript bodies are not intended as durable storage.

### Security warning

- Use this backend only for local/private testing. Production keys belong in a database or secret manager and all traffic must use HTTPS.
- If a real `php/keys.json` ever entered Git history, deleting the working-tree file is insufficient: rotate the key and remove the historical object before publishing.
- Exposed management routes without `DSH_RELAY_ADMIN_KEY` allow remote command execution against connected machines.
- Never publish PHP's built-in development server directly to the Internet; it lacks production-grade timeout, concurrency, and hardening controls.
