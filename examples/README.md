# 参考后端（reference relay）

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
