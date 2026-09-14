# dsh2server 服务器接口规范

> 版本：协议 v1 · 插件 v0.1.0
> 面向对象：后端开发者。本文档定义**服务器侧**必须实现的一切；插件已经按此规范实现完成。

---

## 目录

1. [设计约定](#1-设计约定)
2. [端点与认证](#2-端点与认证)
3. [实例 Key 与多机器管理](#3-实例-key-与多机器管理)
4. [传输层 A：WebSocket](#4-传输层-awebsocket)
5. [传输层 B：HTTP 长轮询（回退）](#5-传输层-bhttp-长轮询回退)
6. [帧（Envelope）参考](#6-帧envelope参考)
7. [订阅模型与事件流](#7-订阅模型与事件流)
8. [事件目录](#8-事件目录)
9. [方法目录（服务器 → 插件）](#9-方法目录服务器--插件)
10. [错误码](#10-错误码)
11. [序号、补发与断线重连](#11-序号补发与断线重连)
12. [后端实现清单](#12-后端实现清单)
13. [安全建议](#13-安全建议)

---

## 1. 设计约定

### 1.1 连接方向

**由 dsh 主动连出，服务器从不主动连接 dsh。**

```
  ┌──────────────────────────┐                    ┌────────────────────────┐
  │  本地计算机 A             │   outbound WS      │                        │
  │  dsh + dsh2server ────┼───────────────────►│      中转服务器         │
  ├──────────────────────────┤                    │  （纯中转，可无状态）    │
  │  本地计算机 B             │   outbound WS      │                        │
  │  dsh + dsh2server ────┼───────────────────►│  内存中保存：           │
  └──────────────────────────┘                    │   · 在线实例表          │
                                                  │   · 每实例最近事件环     │
                                                  │   · 待返回的请求        │
                                                  │  持久化：仅 key 白名单   │
                                                  └────────────────────────┘
```

推论（服务器实现必须满足）：

- 服务器**不需要公网可达之外的任何东西**：不必能访问 dsh 所在机器，不必开放反向端口，不必穿透 NAT。
- 服务器**不需要持久化任何会话内容**。会话列表、工作目录、事件流、任务状态全部可由插件随时重发（见 [§11](#11-序号补发与断线重连)）。唯一需要落盘的是**实例 key 白名单**（这是凭据，不是业务数据）。
- 服务器进程重启后，所有 dsh 会自动重连并重新推送状态；服务器侧"冷启动"是正常状态，不是故障。

### 1.2 两种传输，一套协议

同一套 JSON 帧既走 WebSocket，也走 HTTP 长轮询。后端**可以只实现其中一种**：

| 传输 | 端点 | 建议 |
|---|---|---|
| WebSocket | `{endpoint}/ws` | **首选**。双向、低延迟、真正的流式推送 |
| HTTP 长轮询 | `POST {endpoint}/events` + `GET {endpoint}/inbox` | 回退。用于代理/网关阻断 WebSocket 升级的环境 |

插件按 `transport` 配置选择，默认 `auto`：先尝试 WebSocket，同一次连接尝试失败后立即回退到 HTTP；一旦连上就维持该载体（断线后重新从 WebSocket 开始尝试）。生产环境若明确知道网关不支持 WebSocket，可把 `transport` 固定为 `http`。

### 1.3 HTTP 与 HTTPS 同时可用

协议对 scheme 没有任何偏好，`http://` 与 `https://` 都是**一等公民**：

- 一个部署可以只用 `http://`（内网/回环中转）或只用 `https://`（公网可达）；
- **同一个 dsh 实例可以同时连接多个服务器端点**，scheme 可以混用。插件配置的 `endpoint` 接受：
  - 单个 URL：`https://example.com/dsh-api`
  - URL 列表：`['https://example.com/dsh-api', 'http://10.0.0.5:8787/dsh-api']`
  - 逗号分隔字符串：`'https://example.com/dsh-api, http://10.0.0.5:8787/dsh-api'`

每个端点是一条**完全独立的连接**（本文档称 link），各自拥有自己的载体、订阅集合、心跳、退避策略与补发水位；而实例身份、事件序号、环形缓冲、会话状态和全部方法都是**跨 link 共享**的。因此：

- 多台服务器看到的永远是**同一个 instanceId、同一把 key、同一套事件序号**；
- 任意一个端点不可达、被吊销或很慢，**不影响其它端点**；
- 每台服务器**各自订阅**自己关心的会话流，没订阅的服务器不会收到该流；
- 同一个操作从哪台服务器下发结果都一样，答复原路返回。

> 服务器不需要知道自己不是唯一的：照常按本文档实现即可。唯一差别是 `instance.info` / `instance.health` 会返回 `connections` 数组（本机全部链路的实时状态），而 `connection` 表示"发起本次请求的那条链路"。

参考实现 `examples/server.js` 支持**同时监听 HTTP 与 HTTPS**（`--tls-cert` / `--tls-key` / `--tls-port`），两个监听器共享同一份 key 白名单与实例表——这正是"内网用 http、外网用 https"的典型部署。

### 1.4 术语

| 术语 | 含义 |
|---|---|
| **实例（instance）** | 一个正在运行 dsh 的机器/进程，用 `instanceId` 标识，用 `key` 认证 |
| **会话（session）** | dsh 中的一次对话。id 形如 `session-<uuid>` |
| **工作目录（cwd / workspace）** | 会话的工作目录，会话列表里就是 `cwd` 字段 |
| **turn / step** | 一轮对话 / 一轮中的一次模型调用 |
| **帧（frame）** | 一个 JSON 对象，`type` 字段区分种类 |

---

## 2. 端点与认证

### 2.1 端点推导规则

插件配置里的 `endpoint` 是**服务器 API 的基地址**，可以是单个 URL，也可以是多个（见 [§1.3](#13-http-与-https-同时可用)）：

```
https://example.com/dsh-api
```

对**每一个**端点，插件按下述规则推导出全部地址（`http`/`ws` 自动对应）：

| 用途 | 地址 |
|---|---|
| WebSocket | `wss://example.com/dsh-api/ws` |
| HTTP 上行 | `https://example.com/dsh-api/events` |
| HTTP 下行 | `https://example.com/dsh-api/inbox` |

规则细节：

- `endpoint` 的**路径部分会保留**，只去掉末尾斜杠。上表基于路径 `/dsh-api`。
- `https` → `wss`，`http` → `ws`；如果填的是 `ws(s)://` 也能识别，会换算回 `http(s)` 用于 HTTP 载体。
- **`http://` 与 `https://` 完全等价可用**，不要求 TLS。插件会在启动时对明文端点告警一次（key 与全部会话流量都会明文传输），并在 `connection.insecure` / `instance.health` 里持续标记。
- 三个子路径可通过配置 `wsPath`、`eventsPath`、`inboxPath` 改写（默认 `/ws`、`/events`、`/inbox`）。
- WebSocket 握手 URL 上插件会附带查询参数：`?v=1&instanceId=<id>`；`authMode=query` 时再额外附加 `&key=<key>`。
- 同一实例对每个端点使用**同一把 key**（key 属于机器，不属于端点）。

### 2.2 认证方式（`authMode`）

| 值 | WebSocket | HTTP 载体 | 说明 |
|---|---|---|---|
| `hello`（默认） | key 放在首个 `hello` 帧的 `auth.key` | 自动改为 `Authorization` 头 | **推荐**。不依赖客户端是否支持自定义握手头 |
| `header` | `Authorization: Bearer <key>` 握手头（若运行时支持；否则降级并在日志告警） | `Authorization: Bearer <key>` | 适合有网关统一鉴权的部署 |
| `query` | `?key=<key>` | `?key=<key>` | 兼容性最好，但 key 会进入访问日志，**仅在必要时使用** |

> **HTTP 载体的硬性要求**：长轮询没有"握手帧"，因此每一个 HTTP 请求都必须携带 key。
> 插件在 `authMode=hello` 时也会给 HTTP 请求带上 `Authorization: Bearer <key>`；
> 只有当 `authMode=query` 时才改用查询参数。
> 后端在 HTTP 载体上应按以下顺序取 key：`Authorization: Bearer` → `?key=` → 请求体 `key` → 批内首个 `hello` 帧的 `auth.key`。

### 2.3 认证失败的处理

认证失败时服务器必须：

1. 发送一个 `error` 帧，`fatal: true`，并在编码上明确（例如 `code: "unauthorized"`）；
2. 关闭连接：WebSocket 用关闭码 **4401**，HTTP 返回 **401/403**。

插件收到 fatal error 后会走正常的重连退避（默认 1s 起，指数增长到 60s）。因此**运维在服务器上补登 key 后，机器会自动恢复，无需重启 dsh**。这也是 key 轮换/撤销能够即时生效的机制。

非致命的 `error` 帧只记录日志，不影响连接，可用于限流提示等。

---

## 3. 实例 Key 与多机器管理

### 3.1 Key 的产生

**每个 dsh 实例自行生成并保管自己的 key**，不需要人工分发：

- 首次启动时插件用 CSPRNG 生成 `dshk_` + 43 字符 base64url（256 bit 熵）。
- 保存在**本机**：`<DSH_HOME>/dsh2server/identity.json`（权限 `0600`），同文件里还有 `instanceId`。
- key **不会**被插件写入服务器；插件的日志中会打印一次完整 key 供管理员复制，这也是唯一的配对步骤。
- 也可以在插件配置里用 `key` 字段显式指定（此时不落盘，适合从密钥管理系统注入）。

`instanceId` 默认由主机名 + `DSH_HOME` + 用户名派生（`dsh-<12 hex>`），也可以用配置 `instanceId` 固定。

### 3.2 服务器侧的多机器模型

服务器维护一张**多 key 白名单**，每个 key 对应一台机器：

```jsonc
// keys.json —— 这是服务器唯一需要持久化的文件（凭据，不是业务数据）
{
  "keys": [
    { "key": "dshk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", "label": "办公室台式机", "instanceId": "dsh-1a2b3c4d5e6f" },
    { "key": "dshk_YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY", "label": "笔记本",       "instanceId": "dsh-9f8e7d6c5b4a" }
  ]
}
```

要点：

- **key 是机器的身份**。服务器用"哪个 key 匹配"来决定请求属于哪台机器，`instanceId` 只作为路由标签；不要用 `instanceId` 做鉴权。
- **多机器彼此隔离**：一个 key 只能访问它自己那台机器的会话、工作目录和操作。
- **撤销 = 删除该 key**：删除后该机器下一次重连会被拒绝，其他机器完全不受影响。
- **轮换**：管理员对该机器调用 `instance.rotateKey`，拿到新 key 后写入白名单、删除旧 key；机器会在退避后自动用新 key 连上。
- key 比较必须使用**恒定时间比较**（参考实现里的 `secretEquals`），并且**永远不要**把完整 key 回显给前端界面——只显示指纹 `dshk_AbCdEf…9xYz`。

### 3.3 与插件的配对流程（运维视角）

```text
① 机器上启动 dsh（插件已启用，endpoint 已配置）
       └─ 日志输出： [dsh2server] instance key: dshk_xxxx   ← 复制它

② 服务器登记：
       curl -X POST https://example.com/dsh-api/keys \
            -H 'content-type: application/json' \
            -H 'x-admin-key: <你的管理密钥>' \
            -d '{"key":"dshk_xxxx","label":"办公室台式机"}'

③ 机器在下一次重连（≤60s）后出现在 GET /instances 中。
```

---

## 4. 传输层 A：WebSocket

### 4.1 握手

标准 RFC 6455 升级请求，路径 `{basePath}/ws`：

```
GET /dsh-api/ws?v=1&instanceId=dsh-1a2b3c4d5e6f HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <客户端生成>
Sec-WebSocket-Version: 13
Authorization: Bearer dshk_xxx        ← 仅 authMode=header
```

服务器必须在**升级成功后**才校验 key（除非用 header/query 方式）：校验发生在收到第一个 `hello` 帧时。

### 4.2 消息格式

- 每个 WebSocket **文本帧**（opcode `0x1`）承载**一个** JSON 对象，UTF-8 编码。
- 不使用二进制帧。插件会忽略非文本帧。
- 服务器向插件发送的帧同样是一个文本帧一个 JSON 对象。

### 4.3 心跳

- 插件每 `heartbeatMs`（默认 30s）发送 `{"type":"ping","ts":...}`。
- 服务器应回 `{"type":"pong","ts":...}`。
- 插件若在 `heartbeatTimeoutMs`（默认 90s）内没收到**任何**帧，会主动判定链路失效并重连。
- 服务器可以在 `hello.ack` 里用 `heartbeatMs` 指定自己的期望节奏，插件会采用（钳制在 5s ~ 600s 之间）。
- 服务器也可以主动发标准 WebSocket Ping（控制帧），插件运行时会自动回 Pong。

### 4.4 请求并发与顺序

- 插件对入站请求采用**有界并发**（默认同时处理 8 个，队列上限 256）。
- 因此：**有依赖关系的操作必须等前一个响应返回后再发下一个**。例如先 `session.pause`、拿到响应后再 `session.prompt`。
- 队列溢出时插件直接回 `rate_limited`（`retryable: true`）。

---

## 5. 传输层 B：HTTP 长轮询（回退）

当 WebSocket 不可用时使用。**与 WebSocket 完全相同的帧**，只是换了承载方式。

### 5.1 上行：`POST {basePath}/events`

请求头：

```
Authorization: Bearer dshk_xxx         ← authMode=hello/header 时
Content-Type: application/json
X-Dsh-Instance-Id: dsh-1a2b3c4d5e6f
```

请求体：

```jsonc
{
  "v": 1,
  "instanceId": "dsh-1a2b3c4d5e6f",
  "lastServerCursor": 128,          // 插件已收到的下行序号（用于服务器清理队列）
  "closing": false,                 // true 表示插件正在卸载，这是最后一批
  "frames": [ /* 插件 → 服务器的帧数组，顺序即发送顺序 */ ]
}
```

响应：`200 OK`

```jsonc
{ "accepted": 421 }   // 服务器已接收的最大事件 seq；插件用它更新补发水位
```

要点：

- 插件**批量发送**（默认 ≤50 帧或 ≤200ms 触发一次），因此一个批次里可以同时包含 `hello`、`event`、`response` 等多种帧。
- **首个批次一定包含 `hello` 帧**；服务器应在这个批次里完成认证与实例注册。
- 认证失败返回 `401`/`403`；服务器也可以只接受 `hello` 缺失的批次为非法并返回 `400`。

### 5.2 下行：`GET {basePath}/inbox`

查询参数：

| 参数 | 说明 |
|---|---|
| `instanceId` | 实例标识 |
| `cursor` | 插件已处理的下行序号，服务器可据此清理 |
| `waitMs` | 长轮询挂起时间（默认 25000，上限建议 60000） |
| `key` | 仅 `authMode=query` |

响应：`200 OK`

```jsonc
{
  "frames": [ /* 服务器 → 插件的帧数组，顺序即投递顺序 */ ],
  "cursor": 512,        // 服务器侧本实例下行序号
  "waitMs": 25000       // 可选：指示下一次挂起时长
}
```

- 没有消息时**挂起**最多 `waitMs` 后返回 `{"frames": []}`；也可以返回 `204 No Content`（插件视为"存活但无数据"）。
- **空响应同样算心跳**：插件用"成功轮询"证明服务器存活，因此服务器不要在挂起期间切断连接。
- 服务器必须为每个实例维护一个**内存中的待发队列**；`inbox` 被调用时把它排空。

### 5.3 断线语义

HTTP 载体允许任意时刻断开：插件会重连并**重发未确认的批次**（服务器返回的 `accepted` 是确认水位）。服务器应支持**幂等处理同一批帧**——通过帧内 `seq`/`id` 去重：

- `event` 帧按 `seq` 去重（同一 `seq` 只记录一次）。
- `request` 的 `id` 与 `response` 的 `id` 一一对应；重复请求按 `id` 幂等处理。

---

## 6. 帧（Envelope）参考

所有帧都是 JSON 对象，公共字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | number | 协议版本，当前恒为 `1`。不匹配时插件丢弃该帧并记录告警 |
| `type` | string | 帧种类，见下 |
| `seq` | number? | 单调递增序号，仅 `event` / `ack` 使用 |
| `ts` | number? | 毫秒时间戳（epoch ms） |

### 6.1 插件 → 服务器

#### `hello`（连接首帧，必须最先发送）

```jsonc
{
  "v": 1,
  "type": "hello",
  "instanceId": "dsh-1a2b3c4d5e6f",
  "ts": 1767225600000,
  "auth": {                                  // authMode=hello 时存在
    "type": "instance-key",
    "key": "dshk_xxxxxxxx",
    "instanceId": "dsh-1a2b3c4d5e6f"
  },
  "lastSeq": 4200,                           // 本进程已产生的最大事件 seq
  "resumeFromSeq": 4180,                     // 服务器上次确认到的 seq（补发起点）
  "subscriptions": {                         // 重连前的订阅，供服务器参考
    "topics": ["instance", "sessions", "jobs", "approvals"],
    "sessions": ["session-xxxx"]
  },
  "capabilities": {                          // 见 §9.0
    "agents": true, "sessions": true, "sessionController": true,
    "jobs": true, "goals": true, "commands": true, "approval": true,
    "userQuestions": false, "workspaceRegistry": true,
    "sessionProjections": true, "sessionPersistence": true,
    "sessionList": true, "sessionCreate": true, "sessionPrompt": true,
    "sessionInterrupt": true, "sessionHistory": true, "sessionFork": true,
    "sessionRename": true, "sessionSearch": true, "sessionSelectModel": true,
    "queueUpdate": true, "modelCatalog": true, "commands": true,
    "jobs": true, "goals": true, "approvalPolicy": true,
    "approvalAnswer": true, "questions": false, "workspaces": true,
    "projections": true
  },
  "instance": {
    "hostname": "DESKTOP-ABC",
    "platform": "win32", "arch": "x64", "osRelease": "10.0.26100", "osType": "Windows_NT",
    "cpuModel": "...", "memoryBytes": 34359738368,
    "nodeVersion": "v24.21.0", "pid": 12345,
    "dshHome": "D:\\dsh\\data",
    "liveSessions": 1,
    "displayName": "办公室台式机",
    "pluginVersion": "0.1.0",
    "protocolVersion": 1,
    "identityPersisted": true
  }
}
```

#### `event`（插件 → 服务器，主要数据通道）

```jsonc
{
  "v": 1, "type": "event",
  "seq": 4201,                       // 每实例单调递增；服务器按此去重/补发
  "topic": "sessions",               // instance | sessions | session | jobs | approvals | goals
  "kind": "session/status",          // 见 §8
  "sessionId": "session-xxxx",       // 会话相关事件才有
  "ts": 1767225600123,
  "data": { /* 见 §8 */ },
  "truncated": { "reason": "value exceeds maxPayloadBytes (1048576)", "bytes": 2097152 }
                                      // 仅当负载过大时存在；此时 data 为 null
}
```

#### `response`（回复服务器的 `request`）

```jsonc
{ "v": 1, "type": "response", "id": "req-1", "ok": true, "result": { /* ... */ } }
{ "v": 1, "type": "response", "id": "req-1", "ok": false,
  "error": { "code": "session_not_found", "message": "unknown session \"session-x\"", "retryable": false, "details": { "sessionId": "session-x" } } }
```

#### 其它

| type | 说明 |
|---|---|
| `ping` | `{ "type":"ping", "ts": 1767225600000 }` |
| `ack` | `{ "type":"ack", "seq": 4201 }`，确认收到的服务器帧序号 |
| `bye` | `{ "type":"bye", "reason":"plugin unloading" }`，插件卸载前发送 |
| `log` | `{ "type":"log", "level":"warn", "message":"...", "ts":... }`，插件日志转发（可选处理） |

### 6.2 服务器 → 插件

#### `hello.ack`（必须回复，否则插件 30s 后重连）

```jsonc
{
  "v": 1, "type": "hello.ack",
  "instanceId": "dsh-1a2b3c4d5e6f",
  "serverTime": 1767225600100,
  "heartbeatMs": 30000,          // 可选：期望心跳间隔（5s~600s）
  "resumeFromSeq": 4180,         // 可选：服务器实际持有的水位；插件会补发 seq>该值的事件
  "serverSeq": 512               // 可选：服务器下行序号起点
}
```

`resumeFromSeq` 的语义见 [§11](#11-序号补发与断线重连)。**不填表示不需要补发**。

#### `request`（服务器下发操作）

```jsonc
{ "v": 1, "type": "request", "id": "req-1", "method": "session.prompt",
  "params": { "sessionId": "session-xxxx", "text": "跑一下测试" } }
```

#### `subscribe` / `unsubscribe`（控制事件流）

```jsonc
{ "v": 1, "type": "subscribe", "id": "sub-1",
  "topics": ["instance", "sessions", "jobs", "approvals", "goals"],
  "sessions": ["session-xxxx"],     // 订阅这些会话的逐条事件
  "assistantStream": true,          // 是否同时推送逐 token 的流式片段
  "snapshot": true }                // 默认 true：立即补发一次会话快照
```

- `id` 可选；提供时插件会回一个 `response`，`result` 为当前订阅状态。
- `topics` 只接受 `instance | sessions | jobs | approvals | goals`；未知值报 `invalid_params`。
- `assistantStream` 单独出现且不带 `sessions` 时，作用于当前已订阅的全部会话。
- 订阅状态**不会跨连接保留**：服务器应把 `subscribe` 当作每次 `hello.ack` 之后必须重新执行的动作（插件在 `hello.subscriptions` 里回带上次的订阅供参考，但以服务器为准）。
- 解除订阅：`{ "type":"unsubscribe", "sessions":[...] }` / `{ "topics":[...] }`。

#### `ack` / `pong` / `error`

```jsonc
{ "v": 1, "type": "ack",  "seq": 4201 }
{ "v": 1, "type": "pong", "ts": 1767225600000 }
{ "v": 1, "type": "error", "code": "unauthorized", "message": "unknown instance key", "fatal": true }
```

`fatal: true` 会让插件断开并重连；非 fatal 只记录日志。

---

## 7. 订阅模型与事件流

事件按 **topic** 分域，服务器按需订阅，未订阅的事件插件**根本不会序列化**（因此不订阅时开销接近零）。

| topic | 覆盖内容 | 何时用 |
|---|---|---|
| `instance` | 连接建立/断开/补发溢出通知 | 建议**始终订阅**，用于监控在线状态 |
| `sessions` | 会话列表变化、运行状态、活动时间、错误、暂停/恢复、审批策略变更 | 建议**始终订阅**，控制台主视图 |
| `session` | *单个会话*的逐条持久事件（`session/event`）、流式片段、订阅快照 | 进入某个会话详情页时按 `sessions:[id]` 订阅 |
| `jobs` | 后台任务集合变化 | 建议订阅 |
| `approvals` | 审批请求、提问请求 | 需要远程应答时订阅 |
| `goals` | 目标（goal）变化 | 需要展示/控制长期目标时订阅 |

默认自动订阅（插件配置 `autoSubscribe`）：`instance, sessions, jobs, approvals`。
按会话的自动订阅（`autoSubscribeSessions`）：`none | running | all`，默认 `running`——即**正在干活的会话的逐条事件 + 流式输出会自动推给服务器**，开箱即可看到"实时工作状态"。

### 一条会话从 0 到有数据

```text
服务器                                    插件
  │ hello                              ◄───┤
  │ ──── hello.ack ────────────────────────►│
  │ ──── subscribe{topics:[...]} ──────────►│
  │ ◄─── event session/snapshot ────────────┤   （订阅时的基线：cwd、状态、投影）
  │ ◄─── event session/event  (seq=…) ──────┤   （每条持久事件）
  │ ◄─── event session/assistant-stream ────┤   （逐 token，仅 assistantStream=true）
  │ ◄─── event session/status  ─────────────┤   （running ⇄ idle）
  │ ──── request session.history ──────────►│
  │ ◄─── response {records:[...]} ──────────┤
```

---

## 8. 事件目录

### 8.1 topic = `instance`

| kind | data | 说明 |
|---|---|---|
| `bridge/connected` | `{ instanceId, transport, protocol, pluginVersion, at }` | 握手成功 |
| `bridge/disconnected` | `{ reason, at }` | 链路断开 |
| `bridge/resync` | `{ reason, requested, retainedFrom, lastSeq }` | 服务器请求的补发点早于插件缓冲区，**必须重新拉全量**（`session.list` + `workspace.list` + 重新 `subscribe`） |

### 8.2 topic = `sessions`

| kind | data | 说明 |
|---|---|---|
| `session/created` | `{ sessionId, header }` | 新会话 |
| `session/disposed` | `{ sessionId }` | 会话从内存中移除（日志仍在磁盘上） |
| `session/added` / `session/removed` | `SessionSummary` / `{ sessionId }` | 需要 session-controller 插件；与上一对互补 |
| `session/status` | `{ sessionId, running, status:'running'\|'idle' }` | **工作状态核心事件** |
| `session/activity` | `{ sessionId, updatedAt }` | 人类消息推进了活动时间 |
| `session/error` | `{ sessionId, message }` | 会话级错误（非 turn 内） |
| `session/paused` | `{ sessionId, paused, interrupted?, goalPaused?, queued, at }` | 远程暂停生效 |
| `session/resumed` | `{ sessionId, paused, delivered, goalResumed?, failed?, at }` | 远程恢复生效；`delivered` 是被放行的排队提示数 |
| `session/approval-policy` | `{ sessionId, policy:'ask'\|'never', at }` | 审批策略被远程切换 |

### 8.3 topic = `session`（按会话订阅）

| kind | data | 说明 |
|---|---|---|
| `session/snapshot` | `session.get` 的完整结果 | 订阅瞬间的基线，服务器应先渲染它再应用后续增量 |
| `session/event` | `{ sessionId, type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable? }` | **dsh 持久事件原样转发**，见 §8.6 |
| `session/assistant-stream` | `{ sessionId, frame }` | 模型输出流式片段，见 §8.7 |
| `todos/changed` | `{ sessionId, source:'projection', seq, todos }` | 待办清单变化 |

### 8.4 topic = `jobs`

| kind | data | 说明 |
|---|---|---|
| `jobs/changed` | `{ sessionId: string\|null, at }` | 某个 owner 的可见任务集合变了，服务器应重新调用 `job.list` |

### 8.5 topic = `goals` / `approvals`

| kind | data | 说明 |
|---|---|---|
| `goal/changed` | `{ sessionId, source:'projection'\|'operation', goal, roundsStarted?, seq?, action? }` | 当前目标变更；`goal` 为 `null` 表示已清除 |
| `approval/request` | `{ requestId, sessionId, toolName, callId?, reason?, at }` | 需要审批；用 `approval.respond` 回答 |
| `question/request` | `{ requestId, sessionId, questions:[...], at }` | 需要人类回答；用 `question.answer` 回答 |

> `approval/request` 与 `question/request` 只在插件配置 `forwardApprovals: true` / `forwardQuestions: true` 时产生，且**超时（默认 300s）后自动交给本机 UI**，因此远程不回答永远不会卡死本地会话。

### 8.6 `session/event` 里的 dsh 事件类型

这是 dsh 的**事件溯源日志**，转发时不改写。常见的 `data.type`：

| type | 含义 | 关键字段 |
|---|---|---|
| `turn/start` / `turn/end` | 一轮对话开始/结束 | `turn`, `reason`（`completed`/`aborted`/`error`/`max-tokens`） |
| `step/start` / `step/end` | 一次模型调用开始/结束 | `turn`, `step` |
| `user/message` | 进入模型上下文的用户消息（含系统注入） | 消息体 |
| `assistant/message` | 某步的助手消息（含 token 用量） | `message`, `usage`, `interrupted?` |
| `tool/call` | 模型请求调用工具 | `callId`, `name`, `arguments`（原始 JSON 字符串） |
| `tool/result` | 工具结果 | `message`, `error?`, `meta?` |
| `request/header` / `request/context` | 本轮请求的模型/路由元数据 | `config`, `provider`, `model` |
| `session/end-seed` | 生命周期边界（仅供重放） | — |

> 该目录是**可扩展**的：插件与其它 dsh 插件都可声明新类型。后端必须对未知 `type` 做**透传 + 忽略**处理，不能因为不认识而断流。带 `ignorable: true` 的未知事件可以安全跳过。

### 8.7 `session/assistant-stream` 的 `frame`

```jsonc
{ "type": "start", "attemptId": "...", "revision": 1, "turn": 2, "step": 1 }
{ "type": "chunk", "attemptId": "...", "revision": 1, "index": 0, "time": 1767225600123, "chunk": { /* 模型原始 chunk */ } }
{ "type": "end",   "attemptId": "...", "revision": 1, "index": 42,
  "outcome": { "kind": "committed", "eventType": "assistant/message", "seq": 4210 } }
```

- `index` 在同一个 attempt 内从 0 连续递增；缺口意味着丢帧，服务器应回退到 `session.history` 重新拉取完整消息。
- `end.outcome.kind === "abandoned"` 表示这次尝试被中断/失败且未落盘。
- `chunk` 是模型原始增量，结构由模型适配器决定；要拿"最终文本"请以 `assistant/message` 事件为准。

---

## 9. 方法目录（服务器 → 插件）

### 9.0 能力协商

不是每个 dsh 组合都装了全部插件。`hello.capabilities` 与 `instance.info` 的 `capabilities` 会给出真实可用的能力；如果能力缺失，对应方法返回 `capability_unavailable`，消息里会说明原因。

最关键的几个：

| 能力字段 | 缺失时的影响 |
|---|---|
| `sessionController` | 会话列表/历史/搜索/重命名/模型选择不可用（列表退化为"仅内存中的活动会话"） |
| `sessionPersistence` | 冷会话（磁盘上但当前未加载）不可见 |
| `workspaceRegistry` | `workspace.list` 退化为按会话 `cwd` 聚合 |
| `jobs` / `goals` / `commands` | 对应方法不可用 |
| `approval` | 审批策略切换不可用 |
| `userQuestions` | 结构化提问不可用 |

### 9.1 `instance.*`

#### `instance.info`
获取实例身份、能力、连接状态、订阅状态、暂停会话、待决审批。

- **params**：无
- **result**：
```jsonc
{
  "instanceId": "dsh-1a2b3c4d5e6f",
  "displayName": "办公室台式机",
  "keyFingerprint": "dshk_AbCdEf…9xYz",
  "keyFile": "D:\\dsh\\data\\dsh2server\\identity.json",
  "keyPersisted": true,
  "plugin": { "name": "dsh2server", "version": "0.1.0" },
  "protocol": 1,
  "uptimeMs": 123456,
  "capabilities": { /* ... */ },
  "endpoints": ["https://example.com/dsh-api", "http://10.0.0.5:8787/dsh-api"],
  "methods": ["approval.respond", "command.list", "..."],
  "connection": {                     // ← 发起本次请求的那条链路
    "endpoint": "https://example.com/dsh-api",
    "configuredEndpoint": "https://example.com/dsh-api",
    "insecure": false,                // true = 明文 http
    "state": "connected",             // connected | connecting | idle | disposed
    "transport": "websocket",         // websocket | http
    "connectedSince": 1767225600000,
    "attempts": 0, "wsFailures": 0,
    "lastInboundAt": 1767225600100,
    "serverAckSeq": 4180,
    "subscriptions": { "topics": ["..."], "sessions": ["..."], "assistantStreams": ["..."] },
    "rejected": null,                 // 非 null = 被服务器拒绝（key 错误/被吊销），含 code/message
    "lastError": null
  },
  "connections": [ /* 与 connection 同构，本机全部链路的数组 */ ],
  "subscriptions": { "topics": ["..."], "sessions": ["..."], "assistantStreams": ["..."] },
  "pausedSessions": ["session-xxxx"],
  "pendingDecisions": [ { "requestId": "...", "kind": "approval", "sessionId": "..." } ],
  "config": { /* 已脱敏的生效配置 */ }
}
```

> 多端点部署里，`connection` 让每台服务器都能看到"自己这条链路"的健康状况，`connections` 则让运维在任何一台服务器上都能发现"这台机器还连着别处"。`rejected` 会把真正的失败原因（例如 key 未登记/已吊销）保留下来，而不是被随后的 socket 断开覆盖成泛化的连接错误。

#### `instance.ping`
- **params**：无 → **result**：`{ "pong": true, "ts": 1767225600000 }`

#### `instance.health`
- **result**：`{ ok, connected, endpoints, links: [...], transport, lastError, buffer: { size, limit, dropped, lastSeq }, liveSessions }`
- `connected` 表示**至少有一条**链路可用；`links` 逐条给出每个端点的状态，因此"内网链路断了但公网链路还在"是可观测的。
- 用于监控探针；不触碰 dsh 内部。

#### `instance.key`
读取本机完整 key（用于服务器侧补录）。受 `allowRemoteControl` 控制。
- **result**：`{ instanceId, key, keyFingerprint, keyFile, persisted, warning? }`

> 安全说明：调用方既然已经用这个 key 认证成功，读回它不泄露新信息。普通监控界面**不应**调用本方法，只展示指纹。

#### `instance.rotateKey`
轮换本机 key。**调用后连接会立即断开**，直到服务器登记新 key 才会恢复。

- **params**：`{ "confirm": "<instanceId>" }`（防误触；值必须等于 `instanceId`）
- **result**：`{ instanceId, key, keyFingerprint, note }`
- **errors**：`invalid_params`（confirm 不匹配）、`disabled`

### 9.2 `workspace.*`

#### `workspace.list`
列出这台机器上的**全部工作目录**。

- **result**：
```jsonc
{
  "source": "workspace-registry",   // 或 "session-cwd"（无 workspace 插件时的降级）
  "items": [
    { "id": "ws-1", "path": "D:\\Project\\dsh2server", "title": "dsh2server",
      "createdAt": "...", "updatedAt": "...", "sessionIds": ["session-xxxx"] },
    { "path": "C:\\work\\other", "sessionIds": ["session-yyyy"], "running": 1 }   // session-cwd 形态
  ]
}
```

### 9.3 `session.*`

#### `session.list`
列出可见会话（含内存中活动会话与磁盘上的历史会话，按最近活动排序）。

- **result**：`{ "items": [ SessionSummary, ... ] }`

```jsonc
{
  "sessionId": "session-xxxx",
  "updatedAt": 1767225600000,
  "running": true,                 // ← 当前是否在干活
  "blank": false,                  // 是否还没有任何 turn
  "cwd": "D:\\Project\\dsh2server", // ← 工作目录
  "parentSessionId": null,         // fork 来源
  "origin": "subagent",            // 子代理会话才有
  "attached": true,                // 进程内是否已激活（false = 冷会话）
  "projections": { "asOfSeq": 12, "values": { /* 缓存投影 */ } }
}
```

#### `session.get`
单个会话的完整运行状态。

- **params**：`{ "sessionId": "session-xxxx" }`
- **result**：
```jsonc
{
  "sessionId": "session-xxxx",
  "attached": true,
  "running": true,
  "status": "running",              // running | idle | detached
  "header": { "version": 3, "id": "...", "createdAt": 1767225600000, "cwd": "...",
              "parentSession": null, "isSeeded": false, "agentPreset": "..." },
  "seq": 4210,
  "projections": {                  // 组合里注册了哪些投影就有哪些键
    "asOfSeq": 4210,
    "values": {
      "todos": [ { "id": "t1", "text": "写文档", "status": "in_progress" } ],
      "goal":  { "goal": { "id": "g1", "revision": 3, "phase": "active", "objective": "…" }, "roundsStarted": 2 },
      "inbox": { "next-turn": [], "next-step": [] },
      "modelSelection": { "lastUsed": {...}, "next": {...} }
    }
  },
  "model": { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": null },
  "pending": { "nextTurn": 0, "nextStep": 1 },
  "paused": false,                  // ← 本插件维护的暂停状态
  "queuedPrompts": 0,               // ← 暂停期间被扣住的提示数
  "approvalPolicy": "never",        // 会话级审批策略（null = 用部署默认）
  "pendingDecisions": [ /* 待远程应答的审批/提问 */ ]
}
```

#### `session.create`
新建（或按 id 复用）一个会话。

- **params**：`{ "cwd"?: string, "sessionId"?: string, "workspaceId"?: string, "agentPreset"?: string }`
- **result**：`{ "sessionId": "...", "agentPreset"?: "..." }`
- **errors**：`disabled`、`forbidden`（`cwd` 不在 `allowedCwdPrefixes` 内）、`capability_unavailable`

#### `session.prompt` ★ 核心：下发新命令
把一条人类消息送进会话。

- **params**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sessionId` | string | ✔ | 目标会话 |
| `text` | string | ✔* | 纯文本内容（与 `content` 二选一） |
| `content` | array | ✔* | `[{ "type":"text", "text":"…" }]`，本版本只接受文本块 |
| `mode` | `"queue"` \| `"steer"` | | 默认 `queue`：作为**新一轮**执行；`steer`：喂给**当前正在跑的那一轮**的下一步 |
| `requestId` | string | | 幂等/关联 id；不填由插件生成 |
| `clientTimeZone` | string | | IANA 时区名，例如 `Asia/Shanghai` |
| `force` | boolean | | 默认 `false`。会话处于暂停时是否**强行**投递 |

- **result**：
  - 正常：`{ "accepted": true, "requestId": "..." }`
  - 暂停中：`{ "accepted": true, "deferred": true, "paused": true, "position": 1, "requestId": "..." }`
    —— 消息被**扣在插件内存里**，`session.resume` 时按序放行。
- **errors**：`session_not_found`、`conflict`（暂停且队列已满，`retryable: true`）、`disabled`（`allowRemotePrompt: false`）、`forbidden`、`session/model-unavailable`（该会话没有可用模型路由）

#### `session.interrupt` ★ 中断
中止当前正在执行的 turn，**保留已排队的工作**。

- **params**：`{ "sessionId": "..." }` → **result**：`{ "accepted": true }`

#### `session.cancel`
中止当前 turn 并**丢弃**排队工作（比 interrupt 更彻底）。

- **params**：`{ "sessionId": "..." }` → **result**：`{ "accepted": true }`

#### `session.pause` ★ 暂停运行
1. 立即中止当前 turn（保留排队工作）；
2. 若该会话有 **active 的 goal**，一并暂停，否则 goal 轮次驱动会立刻开新一轮，暂停就形同虚设；
3. 此后到达的 `session.prompt` 被扣在内存里排队。

- **params**：`{ "sessionId": "..." }`
- **result**：`{ "paused": true, "interrupted": true, "goalPaused": false, "queued": 0, "alreadyPaused"?: true }`

#### `session.resume` ★ 恢复
解除暂停，并把暂停期间排队的提示**按顺序**投递给会话；若之前暂停了 goal，则一并恢复。

- **params**：`{ "sessionId": "..." }`
- **result**：`{ "paused": false, "delivered": 3, "goalResumed": true, "failed"?: [{ "requestId": "...", "message": "..." }] }`

#### `session.rename`
- **params**：`{ "sessionId", "title" }` → **result**：`{ "title": "...", "seq": 123 }`
- 需要 session-controller；否则 `capability_unavailable`。

#### `session.fork`
从某个完成 turn 的边界分叉出新会话。

- **params**：`{ "sessionId", "atSeq"?: number }` → **result**：`{ "sessionId": "<新会话>" }`

#### `session.history`
读取一页消息对齐的历史。

- **params**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `sessionId` | ✔ | 目标会话 |
| `throughSeq` | ✔ | 已知的日志上界。**必须来自** `session/snapshot` 或最近一条 `session/event` 的 `seq` |
| `beforeSeq` | | 向后翻页游标（上一页返回的最小 seq） |
| `maxMessages` | | 消息条数预算（1~500） |
| `addressKind` | | `session`（默认）或 `subagent` |
| `parentSessionId` / `childSessionId` / `subagentMode` | | 仅 `addressKind=subagent` 时使用 |

- **result**：`{ "records": [ { "type":"event", "event": { "type", "seq", "time", "data", "surfaceOp"? } } ], "hasMore": true }`
- **errors**：`invalid_params`（缺 `throughSeq`）、`capability_unavailable`

#### `session.search`
在会话内容中全文检索。

- **params**：`{ "query": "..." }` → **result**：`{ "items": [{ "sessionId": "...", "snippet": "..." }], "hasMore": false }`

#### `session.selectModel`
为会话选择下一次请求使用的模型。

- **params**：`{ "sessionId", "provider", "model", "reasoningEffort"? }` → **result**：`{ "selected": { "provider", "model", "reasoningEffort"? } }`

#### `session.modelCatalog`
- **result**：`{ "default": {...}, "routableProviders": ["deepseek"], "groups": [...], "failures": [...] }`

#### `session.queueUpdate`
编辑/删除/提升某个**尚未被消费**的排队消息。

- **params**：
```jsonc
{ "sessionId": "...", "itemId": "<MessageId>",
  "action": { "kind": "edit", "content": [{ "type": "text", "text": "改后的内容" }] } }
// 或 { "kind": "remove" }  /  { "kind": "steer" }（提升为 steer）
```
- **result**：`{ "accepted": true }`

#### `session.approvalPolicy`
读取或切换会话的审批策略。

- **params**：`{ "sessionId", "policy"? }`；`policy` 省略时只读取。
- **result**：`{ "policy": "ask" }` 或 `{ "policy": "never" }`；读取且会话未设置时返回 `{ "policy": null }`
- `"never"` 意味着所有审批问询**直接判定为拒绝**、不打扰任何人——无人值守/CI 场景的确定性选择。`"ask"` 则交给已组装的应答者链（开启 `forwardApprovals` 时包括本服务器）。

### 9.4 `job.*`（后台任务）

#### `job.list`
- **params**：`{ "sessionId"? }`
- **result**：
```jsonc
{ "items": [ { "id": "bash-1", "kind": "bash", "label": "pnpm test",
               "status": "running",       // running | stopping | completed | killed | failed
               "detail": "exit code: 0", "sessionId": "session-xxxx",
               "startedAt": 1767225600000, "finishedAt": null, "reported": false } ] }
```

#### `job.read`
读取自上次读取以来的增量输出（终态后可重复读取最终输出）。

- **params**：`{ "jobId", "sessionId"? }` → **result**：`{ "text": "...", "job": { ... } }`

#### `job.kill`
- **params**：`{ "jobId", "sessionId"?, "reason"? }` → **result**：`{ "result": "requested" | "already-finished" }`

### 9.5 `goal.*`（长期目标）

目标（goal）是"跨多轮自动继续"的持久对象，是无人值守长任务的主要控制点。

| 方法 | params | result |
|---|---|---|
| `goal.get` | `{ sessionId }` | `{ goal: GoalView \| null }` |
| `goal.pause` | `{ sessionId, goalId?, revision?, reason? }` | `{ goal }` |
| `goal.resume` | 同上 | `{ goal }` |
| `goal.complete` | 同上 | `{ goal }` |
| `goal.clear` | 同上 | `{ goal }` |
| `goal.disarm` | `{ sessionId }` | `{ goal }` |

`GoalView`：

```jsonc
{ "id": "g1", "revision": 3, "objective": "把测试补齐并通过 CI",
  "phase": "active",                 // active | paused | blocked | complete
  "blockedReason": { "code": "...", "message": "..." },
  "maxGoalRounds": 10, "roundsStarted": 4,
  "createdAt": 1767225600000, "updatedAt": 1767225600000,
  "activation": "armed" }
```

> `goalId` + `revision` 构成 **CAS（比较并设置）**：省略时插件会先读取当前值再提交。并发修改会返回 `conflict`，服务器应重新读取后重试。

### 9.6 `command.*`（斜杠命令）

#### `command.list`
- **params**：`{ "sessionId" }` → **result**：`{ "items": [ { "name": "compact", "description": "…", "input"?: {...} } ] }`

#### `command.run`
执行一条斜杠命令（**不经过模型**），例如 `/compact`、`/goal`、`/export`。

- **params**：`{ "sessionId", "line": "/compact" }`
- **result**：`{ "commandId": "cmd-1", "result": { /* 命令自定义 */ } }`
- **errors**：`invalid_params`（`line` 不以 `/` 开头）、`not_found`（命令不存在）、`disabled`（`allowRemoteCommand: false`）

### 9.7 `approval.*` / `question.*`（远程应答）

#### `approval.respond`
回答 `approval/request` 事件。

- **params**：`{ "requestId": "...", "outcome": "allowed-once" | "rejected" | "cancelled" }`
- **result**：`{ "accepted": true, "matched": true }`
- `allowed-once` 是**唯一**的放行语义，且只对它对应的那一次请求有效。
- `matched: false` 表示该请求已经超时/已被本机回答——**属于正常情况，不是错误**。

#### `question.answer`
回答 `question/request` 事件。

- **params**：
```jsonc
{ "requestId": "...",
  "answers": [ { "id": "<questionId>", "selected": ["选项A"], "custom": "其它文本" } ] }
```
- **result**：`{ "accepted": true, "matched": true }`

---

## 10. 错误码

`response.error.code` 是**稳定**的机器可读枚举，后端必须按 code 分支，不要解析 message。

| code | 含义 | 建议处理 |
|---|---|---|
| `bad_frame` | 帧不是合法 JSON 对象或版本不符 | 记录并丢弃 |
| `bad_request` | `request` 帧本身不合法（缺 method/id） | 修正请求 |
| `invalid_params` | 参数缺失/类型错/超范围 | 修正参数；`details` 里有字段名 |
| `unknown_method` | 方法不存在；`details.methods` 给出全部可用方法 | 修正 method 或做能力协商 |
| `not_found` | 目标对象不存在（命令、目标等） | 刷新状态 |
| `session_not_found` | 会话不存在或未激活 | 刷新 `session.list` |
| `session_paused` | 会话处于暂停 | 先 `session.resume`，或带 `force: true` |
| `agent_busy` | 会话正忙，无法执行该操作 | 稍后重试 |
| `capability_unavailable` | 该 dsh 组合没有这个能力 | 读 `capabilities`，隐藏对应 UI |
| `disabled` | 被插件配置显式关闭 | 提示管理员改配置 |
| `forbidden` | 越权（如 `cwd` 不在白名单） | 不要重试 |
| `conflict` | 并发冲突（goal revision、暂停队列满） | 重新读取后重试 |
| `timeout` | 方法在 `requestTimeoutMs` 内没完成 | 可重试 |
| `rate_limited` | 请求队列溢出 | 退避后重试 |
| `payload_too_large` | 负载超限 | 缩小请求 |
| `internal` | 未分类的内部错误 | 记录并上报 |

---

## 11. 序号、补发与断线重连

### 11.1 上行（插件 → 服务器）

- 每个 `event` 帧带 `seq`，**在一个 dsh 进程生命周期内单调递增且不重复**。
- 插件在内存里保留最近 `bufferSize`（默认 2000）条事件。
- 重连时插件在 `hello.resumeFromSeq` 里带上"服务器上次确认到的水位"，服务器在 `hello.ack.resumeFromSeq` 里**回显它真实持有的水位**：

| 服务器回答 | 插件行为 |
|---|---|
| 省略 `resumeFromSeq` | 不补发（服务器自行拉全量） |
| `resumeFromSeq = N`，且缓冲区覆盖 | 立即重发 `seq > N` 的全部事件 |
| `resumeFromSeq` 早于缓冲区起点 | 发一条 `instance` / `bridge/resync` 事件，**服务器必须重新拉全量** |

推荐的服务器行为：

- **WebSocket**：在内存里记录每个实例的最后一个 `seq`，重连时把它作为 `resumeFromSeq` 回给插件 → 零丢失、零重复地续上。
- **HTTP**：用 `POST /events` 响应里的 `accepted` 作为水位，下次 `hello.resumeFromSeq` 自然带上。

### 11.2 下行（服务器 → 插件）

- 服务器可以给下行帧带 `seq`；插件会在 `ack` 帧里回报已收到的最大序号。
- HTTP 载体的 `cursor` 起同样作用（`?cursor=` 上行、`cursor` 下行）。

### 11.3 重连策略

- 指数退避：`min(maxDelay, initialDelay × factor^(n-1))`，再叠加 `jitterRatio` 抖动；默认 1s → 60s，抖动 ±20%。
- 任何一次成功握手都会把退避计数清零。
- `reconnect: false` 时，失败一次后插件停止尝试（仅用于测试/一次性场景）。

### 11.4 服务器重启

服务器重启后，所有 dsh 会在退避窗口内重连（最坏 60s）。此时服务器**没有任何历史状态**，正确做法是：

```text
hello.ack（不带 resumeFromSeq）
  → subscribe（topics + 关心的 sessions）
  → session.list / workspace.list 拉全量
  → 之后纯靠事件增量维持
```

---

## 12. 后端实现清单

一个满足规范的最小后端需要做到：

- [ ] **端点**：`{basePath}/ws`（升级）、`{basePath}/events`（POST）、`{basePath}/inbox`（GET）。至少实现 WebSocket 或 HTTP 之一。
- [ ] **Key 白名单**：多 key → 多机器；恒定时间比较；持久化（唯一需要落盘的东西）。
- [ ] **认证**：按 `authMode` 从 `hello.auth.key` / `Authorization` / `?key=` 取 key；失败发 fatal error 并断开（WS 4401 / HTTP 401）。
- [ ] **`hello` → `hello.ack`**：必须回，并带上 `resumeFromSeq`（如果有历史水位）。
- [ ] **`subscribe`**：`hello.ack` 之后主动订阅需要的 topic 与会话。
- [ ] **请求/响应**：生成 `id`，发 `request`，用 `id` 匹配 `response`，实现超时与取消。
- [ ] **事件接收**：按 `seq` 去重、按需持久化（不持久化也完全合规）。
- [ ] **心跳**：回 `pong`；或依赖插件的 `ping` 并保证 90s 内有任何下行帧。
- [ ] **内存队列**：HTTP 载体需要 per-instance 待发队列 + 长轮询挂起。
- [ ] **在 HTTP 载体上处理 `bye`**：WebSocket 载体靠 socket 关闭就知道机器下线，HTTP 载体没有这个信号——插件卸载前会发一帧 `bye`，服务器应据此把实例标记为"已断开"（建议**标记**而不是删除：紧接其后的重连会与删除抢跑）。同时把 `lastSeenAt` 超过一段时间未更新的实例视为离线。
- [ ] **多机器隔离**：所有请求都作用于"key 对应的那台机器"，绝不能跨机器。

### 12.1 参考实现

本仓库提供两份可直接运行、且被测试当作真实服务端使用的实现：

| 实现 | 运行方式 | 载体 | 适合 |
|---|---|---|---|
| Node（[`examples/server.js`](../examples/server.js)） | `node examples/server.js --port 8787 --keys ./examples/keys.json` | WebSocket + HTTP 长轮询，可同时监听 HTTP/HTTPS | 生产级起点 |
| PHP（[`php/dsh-relay.php`](../php/dsh-relay.php)） | `php -S 127.0.0.1:8080 php/dsh-relay.php` | HTTP 长轮询（PHP 无法升级 WebSocket） | 没有 Node 环境、想立刻用网页测试台联调 |

PHP 版自带一个完整的 HTML 调试台（配对、在线机器、会话与工作目录、下发命令、中断/暂停/恢复、
任务与目标、审批应答、事件流、一键自检），打开 `http://127.0.0.1:8080/` 即用。

下面是 Node 版的一条完整 cURL 演练：

```bash
# 1. 启动中转服务器
node examples/server.js --port 8787 --keys ./examples/keys.json

# 2. 打印某台机器的 key 并登记
node scripts/show-key.js
curl -X POST http://127.0.0.1:8787/dsh-api/keys \
     -H 'content-type: application/json' \
     -d '{"key":"dshk_...","label":"我的电脑"}'

# 3. 查看在线机器
curl http://127.0.0.1:8787/dsh-api/instances

# 4. 远程操作：列出会话
curl -X POST http://127.0.0.1:8787/dsh-api/instances/dsh-xxxx/request \
     -H 'content-type: application/json' \
     -d '{"method":"session.list","params":{}}'

# 5. 下发一条命令
curl -X POST http://127.0.0.1:8787/dsh-api/instances/dsh-xxxx/request \
     -H 'content-type: application/json' \
     -d '{"method":"session.prompt","params":{"sessionId":"session-xxxx","text":"跑一下单元测试"}}'

# 6. 暂停 / 恢复
curl -X POST ... -d '{"method":"session.pause","params":{"sessionId":"session-xxxx"}}'
curl -X POST ... -d '{"method":"session.resume","params":{"sessionId":"session-xxxx"}}'
```

---

## 13. 安全建议

1. **优先使用 TLS**：公网可达的端点用 `https://`/`wss://`，key 等同于该机器的登录凭据。`http://` 同样受支持（内网/回环中转很常见），但此时 key 与会话内容都是明文，插件会在启动日志明确告警并在 `connection.insecure` 中持续标记。
2. **key 只存白名单，不进日志**：日志与界面只出现指纹；HTTP 访问日志若会记录查询串，请使用 `authMode=header` 或 `hello`。
3. **key 轮换路径要演练**：`instance.rotateKey` → 服务器登记新 key → 删除旧 key。删除旧 key 即是**即时吊销**：该机器下一次重连会被拒绝（最长 60s 内生效）。
4. **限制远程能力**：插件侧可关闭 `allowRemotePrompt` / `allowRemoteControl` / `allowRemoteCommand`，或用 `allowedCwdPrefixes` 把远程操作限制在指定目录树内。
5. **谨慎开启审批转发**：`forwardApprovals: true` 意味着"服务器上的一个人可以批准本机的工具调用"。开启前确认服务器本身的可信边界；不需要时保持默认 `false`（本机 UI 仍是唯一应答者）。
6. **服务器侧做鉴权分级**：管理接口（列出机器、下发操作）与只读接口分开授权；允许多少人向机器下发命令，是这套架构里权限最大的一个开关。
7. **不要在服务器上存储会话内容**：协议不要求，且一旦存储，其泄露影响远超 key 泄露。若确实需要审计，请单独评估并加密。
8. **多端点等于多个信任边界**：一台机器同时连多个服务器时，任一服务器的持有者都拥有等同的远程操作能力。只配置你确实要授权的端点；`instance.info` 的 `connections` 会如实暴露这一点，便于审计。
9. **私有 CA / 自签名证书**：让 Node 信任私有 CA 用 `NODE_EXTRA_CA_CERTS=/path/ca.pem`（推荐）；仅在已完全可信的网络上才使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
