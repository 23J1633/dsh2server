[中文](#中文) | [English](#english)

# 参考后端（reference relay）

## 中文

## A2S 生态（同系列开源仓库）

A2S 按组件拆分为以下同系列仓库，所有者均为 `23J1633`。/ A2S is split into the following sibling repositories, all owned by `23J1633`.

| 仓库 / Repository | 作用 / Role | GitHub |
|---|---|---|
| A2Switch | Windows 桌面控制中心 / Windows desktop control center | [23J1633/A2Switch](https://github.com/23J1633/A2Switch) |
| cc2server | Claude Code 桥接器 / Claude Code bridge | [23J1633/cc2server](https://github.com/23J1633/cc2server) |
| codex2server | Codex 桥接器 / Codex bridge | [23J1633/codex2server](https://github.com/23J1633/codex2server) |
| dsh2server | DeepSeek Harness 插件 / DeepSeek Harness plugin | [23J1633/dsh2server](https://github.com/23J1633/dsh2server) |
| server-api | 中转服务与 Web 控制台 / relay server and Web console | [23J1633/server-api](https://github.com/23J1633/server-api) |
| a2s_app | Flutter Android 客户端 / Flutter Android client | [23J1633/a2s_app](https://github.com/23J1633/a2s_app) |

这里是一个**零依赖、可直接运行**的 `dsh2server` 服务器实现。它的作用是：

1. **作为规范的可执行样本** —— `docs/API.md` 里每一条约定，这里都有对应代码，而且端到端测试全部跑在它上面（`test/e2e.test.js`、`test/multi-endpoint.test.js`、`test/cordis.test.js`）。
2. **作为你自研后端的起点** —— 纯 `node:http` + 手写 WebSocket，没有框架魔法，用你熟悉的技术栈照着重写即可。

> 生产环境请使用你所在平台的成熟 WebSocket 库（`ws` / uWebSockets / FastAPI / Gorilla / …）。
> **重要的是线协议，而不是这些文件。**

## 文件

| 文件 | 作用 |
|---|---|
| `server.js` | 中转服务器：多 key 白名单、WebSocket + HTTP 长轮询双载体、HTTP/HTTPS 双监听、内存事件环、管理接口 |
| `ws.js` | 极简 RFC 6455 WebSocket 服务端（握手、分片重组、ping/pong、close） |
| `keys.example.json` | key 白名单示例（多台机器） |

## 运行

```bash
# 默认 127.0.0.1:8787，无 key 文件（运行时用 POST /keys 添加）
node examples/server.js

# 指定端口与 key 文件
node examples/server.js --port 8787 --host 0.0.0.0 --keys ./examples/keys.json

# HTTP + HTTPS 同时监听（推荐用于「内网 http、公网 https」）
node examples/server.js --port 8787 --tls-port 8443 \
     --tls-cert ./cert.pem --tls-key ./key.pem --keys ./examples/keys.json

# 非本机访问管理接口时，必须配置管理密钥
node examples/server.js --port 8787 --keys ./examples/keys.json --admin-key 'change-me'
```

启动后把插件的 `endpoint` 指向打印出来的地址（可以是其中一个，也可以是两个都填，见下）。

### 同时使用两种协议

两个监听器共享**同一个请求处理器、同一份 key 白名单、同一份实例表**，所以：

- 内网设备填 `http://10.0.0.5:8787/dsh-api`，公网设备填 `https://relay.example.com:8443/dsh-api`；
- 甚至可以**让同一台 dsh 同时连两个**（插件 `endpoint` 写列表），两条链路互不影响；
- 管理接口在任一监听器上都可用，看到的机器列表完全一致。

服务器本身不区分请求来自哪种监听器，唯一记录的是 `GET /instances` 里的 `tls: true/false` 字段，便于审计。

## 端点

### 数据面（插件使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`（升级） | `/dsh-api/ws` | WebSocket 载体（首选） |
| `POST` | `/dsh-api/events` | HTTP 载体上行（批量帧） |
| `GET` | `/dsh-api/inbox` | HTTP 载体下行（长轮询） |

> 这三个路径在 HTTP 与 HTTPS 两个监听器上都存在（`ws://` / `wss://`、`http://` / `https://`）。

### 管理面（你的控制台使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/dsh-api/` | 协议信息与在线机器数 |
| `GET` | `/dsh-api/instances` | 在线机器列表（含能力、订阅、最近事件类型） |
| `GET` | `/dsh-api/instances/:id/events?since=&limit=` | 最近事件（**仅内存**，上限 1000 条） |
| `POST` | `/dsh-api/instances/:id/request` | 下发一个操作，`{ "method": "...", "params": {...}, "timeoutMs"? }` |
| `POST` | `/dsh-api/instances/:id/subscribe` | 调整订阅 `{ topics?, sessions?, assistantStream? }` |
| `GET` | `/dsh-api/keys` | key 指纹列表 |
| `POST` | `/dsh-api/keys` | 登记机器 `{ "key": "dshk_…", "label": "…" }` |
| `POST` | `/dsh-api/keys/remove` | 吊销 `{ "key": "dshk_…" }` 或 `{ "fingerprint": "dshk_AbCd…9xYz" }` |

> 管理面默认**仅允许回环地址**访问。若配置了 `--admin-key`，则需要请求头 `x-admin-key: <值>`（或 `?adminKey=`），此时才允许非本机访问。

## 完整示例

```bash
BASE=http://127.0.0.1:8787/dsh-api

# 1. 登记一台机器的 key（key 由 `node scripts/show-key.js` 得到）
curl -X POST $BASE/keys -H 'content-type: application/json' \
     -d '{"key":"dshk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","label":"我的笔记本"}'

# 2. 看在线机器
curl -s $BASE/instances | jq

# 3. 列出这台机器上的会话与工作目录
ID=dsh-1a2b3c4d5e6f
curl -s -X POST $BASE/instances/$ID/request -H 'content-type: application/json' \
     -d '{"method":"session.list","params":{}}' | jq
curl -s -X POST $BASE/instances/$ID/request -H 'content-type: application/json' \
     -d '{"method":"workspace.list","params":{}}' | jq

# 4. 订阅某个会话的实时事件流
curl -s -X POST $BASE/instances/$ID/subscribe -H 'content-type: application/json' \
     -d '{"sessions":["session-xxxx"],"assistantStream":true}'

# 5. 下发一条命令
curl -s -X POST $BASE/instances/$ID/request -H 'content-type: application/json' \
     -d '{"method":"session.prompt","params":{"sessionId":"session-xxxx","text":"跑一下 npm test"}}' | jq

# 6. 暂停 / 中断 / 恢复
curl -s -X POST $BASE/instances/$ID/request -H 'content-type: application/json' \
     -d '{"method":"session.pause","params":{"sessionId":"session-xxxx"}}' | jq
curl -s -X POST $BASE/instances/$ID/request -H 'content-type: application/json' \
     -d '{"method":"session.interrupt","params":{"sessionId":"session-xxxx"}}' | jq
curl -s -X POST $BASE/instances/$ID/request -H 'content-type: application/json' \
     -d '{"method":"session.resume","params":{"sessionId":"session-xxxx"}}' | jq

# 7. 轮换某台机器的 key（之后必须把新 key 登记进白名单，否则该机器会一直被拒）
curl -s -X POST $BASE/instances/$ID/request -H 'content-type: application/json' \
     -d '{"method":"instance.rotateKey","params":{"confirm":"dsh-1a2b3c4d5e6f"}}' | jq
```

## 这个实现刻意证明的几件事

- **服务器可以完全无状态**：`instances` / `events` / 待发队列都在内存里，进程重启后各机器自动重连并重新上报。只有 key 白名单落盘（`keys.json` 支持热加载，边改边生效）。
- **多机器天然隔离**：一个 key 对应一台机器，任何请求都必须先通过 key 找到实例，不存在跨机器操作。
- **两种载体一套协议**：`ingest()` 处理来自 WebSocket 和 HTTP 长轮询的同一批帧，换成任何语言实现时也只是"从 socket 读"与"从 HTTP body 读"的差别。
- **两种协议一套部署**：HTTP 与 HTTPS 监听器共用处理器，不需要为明文/加密各写一套逻辑。
- **key 轮换即吊销**：删除 key → 该机器下次重连被拒 → 登记新 key → 自动恢复（`test/e2e.test.js` 里有完整断言）。

---

## English

This directory contains a zero-dependency executable reference relay for `dsh2server`. It is both an implementation companion to `docs/API.md` and a convenient local debugger. Production multi-Agent deployments should use the top-level `server-api` project instead.

### Files and run commands

- `server.js`: HTTP/HTTPS/WebSocket relay, key registry, management routes, queues, events, and protocol handling.
- `keys.example.json`: safe allowlist example.

```bash
# Local HTTP on 127.0.0.1:8787
node examples/server.js

# Custom port and key file
DSH_RELAY_PORT=8787 DSH_RELAY_KEYS_FILE=./keys.json node examples/server.js

# Optional HTTPS listener
DSH_RELAY_TLS_PORT=8443 \
DSH_RELAY_TLS_CERT=/path/fullchain.pem \
DSH_RELAY_TLS_KEY=/path/privkey.pem \
node examples/server.js
```

When management routes are reachable from anything other than localhost, set `DSH_RELAY_ADMIN_KEY` and send it in `x-admin-key`. Never expose test keys or plaintext control traffic publicly.

### Protocol surfaces

Agents use WebSocket `/dsh-api/ws` or HTTP `/dsh-api/events` plus `/dsh-api/inbox`. Operators use health, key registration, instance listing/details, event streams, and per-instance request routes. Both carriers feed the same frame ingestion logic, so behavior is equivalent apart from latency.

### End-to-end workflow

Register a machine key, wait for the instance to appear, list sessions/workspaces, subscribe to events, issue a `session.prompt`, and use interrupt/pause/resume as required. Key rotation intentionally rejects the old value until the new value is registered. The exact curl examples are provided in the Chinese section above.

### Design properties demonstrated

- Runtime instance, event, and queue state can remain in memory; reconnecting Agents reconstruct it after restart.
- One key maps to one machine, naturally isolating requests across devices.
- WebSocket and HTTP long polling carry the same protocol frames.
- HTTP and HTTPS listeners share one request handler.
- Deleting/rotating a key immediately revokes later reconnect attempts.

The automated E2E, multi-endpoint, and Cordis tests run against this implementation.
