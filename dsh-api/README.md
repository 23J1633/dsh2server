[中文](#中文) | [English](#english)

# dsh-api（旧版单 Agent 参考服务器）

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

> 本目录保留给 dsh2server 独立使用和兼容性测试。A2S 正式部署请使用仓库根目录的 [`server-api`](../../server-api/)：它支持 Claude、Codex、DSH 共用设备 key、统一设备聚合和多 Agent 控制台，并继续兼容 `/dsh-api` 路径。下面内容描述旧版独立部署。

按 [`docs/API.md`](../docs/API.md)（协议 v1）实现的服务器侧，外加一个复刻 dsh 本地界面的图形化控制台。

```
  你的电脑                          本服务器 (1.14.130.76)
  ┌─────────────────┐  主动连出      ┌──────────────────────────────┐
  │  dsh + 插件      │ ─────────────►│  dsh-api (Node) :50443  TLS  │
  │  dshk_xxxx       │  wss / https  │   · /dsh-api/ws   WebSocket  │
  └─────────────────┘               │   · /dsh-api/events + /inbox │
                                    │   · /            控制台界面   │
                                    └──────────────────────────────┘
```

服务器不保存会话正文，只持久化 key 白名单和控制台归档索引；进程重启后 dsh 会自动重连补齐其余状态。

---

## 1. 端点

| 用途 | 地址 |
|---|---|
| 插件 endpoint（填进 dsh 插件配置） | `https://www.23j1633.xyz:50443/dsh-api` |
| WebSocket | `wss://www.23j1633.xyz:50443/dsh-api/ws` |
| HTTP 上行 | `https://www.23j1633.xyz:50443/dsh-api/events` |
| HTTP 下行 | `https://www.23j1633.xyz:50443/dsh-api/inbox` |
| 控制台界面 | `https://www.23j1633.xyz:50443/` |
| 健康检查（免鉴权） | `https://www.23j1633.xyz:50443/dsh-api/health` |

端口 50443 已在 1Panel 防火墙放行（规则名 `rp400-dsh`），TLS 复用站点证书
`www.23j1633.xyz`。注意 apex 域名 `23j1633.xyz` 没有 A 记录，**必须用 `www.`**。

---

## 2. 部署与运行

```bash
cd /opt/1panel/www/sites/Main/index/dsh-api
npm install          # 只有一个依赖：ws

./start.sh           # 后台启动
./start.sh status    # 状态
./start.sh logs      # 跟踪日志
./start.sh restart   # 重启
./start.sh stop      # 停止
```

首次启动会生成：

```
~/.dsh-relay/            ← 数据目录，刻意放在网站根目录之外
├── admin-key.txt        管理密钥（0600），登录控制台用
├── keys.json            实例 key 白名单（0600）
├── archives.json        控制台归档索引（0600，不含会话正文）
├── config.json          生效配置，改完重启即可
└── relay.log            运行日志
```

### 开机自启

没有 root 时用用户级 crontab（免密 sudo 不可用）：

```bash
crontab -e
# 加入一行：
@reboot /opt/1panel/www/sites/Main/index/dsh-api/start.sh start >/dev/null 2>&1
```

有 root 时更推荐 systemd，把 `ExecStart` 指向 `start.sh start` 即可。

---

## 3. 配对（把机器接进来）

1. 在电脑上启动 dsh（插件已启用，`endpoint` 填上面的地址）。启动日志里会打印一次
   `instance key: dshk_xxxx…`，复制它。
2. 打开控制台 → 「设置 → 机器与密钥」→ 粘贴 key → 写个备注名 → 点「登记」。
3. 机器在下一次重连（≤60s）内出现在实例列表里。也可以直接调接口：

```bash
curl -X POST https://www.23j1633.xyz:50443/dsh-api/keys \
     -H 'content-type: application/json' \
     -H 'x-admin-key: <管理密钥>' \
     -d '{"key":"dshk_xxxx","label":"办公室台式机"}'
```

> **登记之后不要重启服务器**——不需要。补登/吊销/编辑 key 都是即时生效的：
> 吊销后该机器下次重连会被拒（WS 4401），最长 60s 内生效，其它机器完全不受影响。

已登记的机器可以随时改备注名或换 key（控制台「设置 → 机器与密钥」里的「编辑」）：

```bash
curl -X PATCH https://www.23j1633.xyz:50443/dsh-api/keys/<id> \
     -H 'content-type: application/json' \
     -H 'x-admin-key: <管理密钥>' \
     -d '{"label":"新名字","key":"dshk_yyyy"}'
```

改过名字之后，重连时不再被插件上报的标签覆盖（白名单里记住 `renamed`）。
**换 key 只改服务器侧记录**，不去动机器上的 dsh——填的必须是那台机器当前实际持有的
key，否则它下次重连会被拒。想让两边同时换，用控制台里的「轮换 key」
（走插件的 `instance.rotateKey`）。

---

## 4. 界面

打开 <https://www.23j1633.xyz:50443/>，输入管理密钥（`~/.dsh-relay/admin-key.txt`）即可。

这是 **dsh 本地 Web UI 的复刻**（对应仓库 `reference/deepseek-harness-master`）：三栏骨架、左侧边栏、对话转录、底部输入框都按上游
`packages/client/*` 的源码逐项还原（几何尺寸、圆角、间距、字号、行高），配色直接使用
上游的 `--dsw-*` 设计 token，深色主题一并支持。区别只有两处，都是云端特有的：

- **标志正下方多了「选择机器」下拉框** —— 上游没有这个概念（它只连本机），
  这里把多台 dsh 的选择放在品牌行下面，切换机器等于切换整个数据源。
- **管理密钥、机器与密钥管理收进了设置面板**，主界面保持和本地一致。

### 界面结构

```
┌─ 侧边栏 280px ────────┬─ 主区 ────────────────────────────────┐
│ 鲸鱼 + deepseek HARNESS│ 会话头：机器 / 会话名  ← 与本地一致    │
│ ▸ 选择机器  ▼          │ ─────────────────────────────────────  │
│ ▸ 新会话               │ 用户气泡（右对齐 22px 圆角）           │
│ 会话              ⟳   │ 助手 markdown（标题/列表/代码块/表格）  │
│  demo            1    │ ▸ 3 个工具调用 → 展开终端与 diff        │
│    模拟会话   3 秒前   │ 助手最终答复 + token 用量              │
│                       │ 待决审批卡片（允许一次 / 拒绝 / 取消）  │
│ ● 实时 · 自动刷新      │ ┌──────────────────────────────────┐  │
│ ⚙ 设置                │ │ 输入框  命令 · 队列  模型    ↑    │  │
└───────────────────────┴──────────────────────────────────────┘
```

**对话显示**有「紧凑 / 标准」两档，默认紧凑：已结束的轮次会把中间的步骤折成一行
「N 个工具调用 · M 条消息」，点开才展开——这是上游最标志性的交互，这里一比一还原。
折叠的过程节点仍留在 DOM 里（`hidden`），所以浏览器 Ctrl+F 能穿透展开。

### 能做什么

| 位置 | 操作 |
|---|---|
| 侧边栏 | 切机器、新建会话、按工作目录分组的会话列表、会话重命名/分叉/复制 ID、折叠成 56px icon rail |
| 会话头 | 中断、取消并清空排队、暂停/恢复、重命名、分叉、历史消息、全文检索、审批策略、目标(goal)、`/compact`、`/export` |
| 输入框 | 下发提示（Enter 发送，Shift+Enter 换行，输入法组合中不误发）、队列/插话模式、斜杠命令菜单、模型选择（读 `session.modelCatalog`）、运行中按钮变「中断」 |
| 转录区 | 流式逐 token 渲染、工具调用展开看终端输出与 diff、审批/提问就地应答 |
| 空状态 | 鲸鱼 Hero + 工作目录 chip；**直接输入就会新建会话**，和本地手感一致 |
| 设置 → 通用设置 | 外观（浅色/深色/跟随系统）、字号 12–17、对话显示、**自动刷新间隔**、管理密钥、服务端点 |
| 设置 → 机器与密钥 | 当前机器信息与能力徽章、登记实例 key、吊销、**轮换 key**、查看实例信息 |
| 设置 → Agent 预设 | 查看本机预设组合、设为下次新会话默认、查看/复制/删除用户预设 |
| 设置 → 调试 | `instance.ping` / `info` / `health`、任意方法调用、链路上下行原始帧、服务端日志 |

快捷键：`Ctrl/Cmd + ,` 打开设置，`Ctrl/Cmd + Shift + R` 立即刷新。

### 云端和本地怎么保持一致

三层叠加，任何一层挂掉都还有兜底：

1. **实时事件流（主）** —— 服务器与插件之间是常驻 WebSocket，`session/status`、
   `session/activity`、`session/event`、逐 token 的 `session/assistant-stream` 都是推过来的，
   不轮询。
2. **自动刷新拉取（兜底）** —— 按设置里的间隔（默认 5 秒）重新调 `session.list` 与
   `/instances/:id`，保证会话列表、运行状态、待决审批这些「集合型」数据不会因为丢帧而失真。
   标签页不可见时自动暂停，切回前台立刻拉一次。
3. **打开会话时全量对齐** —— 打开任意会话都会重新 `session.get` 拿基线，再按 `throughSeq`
   调 `session.history` 拉完整转录，之后才靠事件增量维持。历史分页用「加载更早的消息」按钮。

> 服务器侧默认 `autoSubscribe.sessions = "running"`：正在干活的会话会把逐条事件与流式输出
> 自动推上来，所以**没打开的会话在侧边栏里也有实时的状态点**，和本地一致。

### 右侧栏

会话头右上角的按钮展开右侧面板，四个标签页，**按插件上报的能力位自动出现**：

| 标签页 | 内容 | 依赖能力位 |
|---|---|---|
| 轨迹 | 顶部时间线 + 事件账本 + 事件详情（见下节） | `sessionEvents` |
| 文件 | 浏览工作区目录、查看文本文件内容 | `fileBrowser` |
| 终端 | 远程 shell（**默认关闭**，设置 → 通用设置 → 高级里打开） | `terminal` |
| 任务 | `job.list` / `job.read` / `job.kill` | `jobs` |

### 轨迹页

对话区顶部的「轨迹」是与「对话」并列的视图，逐字复刻自上游
`packages/client/ui-trajectory`：**工具条 + 顶部时间线 + 事件账本 + 右侧事件详情**。
数据侧（`trajectory-model.js`）对应上游的 `layout.ts` / `timeline.ts` /
`trajectory-record.ts` / `trajectory-virtual-rows.ts` / `trajectory-search-index.ts`
与那一组 `trajectory-*-definition.ts` 状态机，只是输入换成插件经 `session.events`
给的原始日志。

| 区块 | 内容 |
|---|---|
| 工具条 | 「时长」（等宽操作序 ↔ 真实耗时）、「轮次」「调用」两个全局折叠开关、搜索框 |
| 时间线 | 输入 / 模型 / 工具 三条泳道，按 kind 上色，助手块带 TTFT→解码渐变；拖动框选、滚轮缩放、右键平移、Esc 清除 |
| 账本 | 左侧 kind 标签（系统 / 用户 / 上下文 / 已压缩 / 助手 / 工具 / 子工具）+ 右侧单行摘要；轮次标题、请求圆点、turn 竖轨、行内搜索过滤、超 100 行自动虚拟滚动 |
| 事件详情 | 点任一行打开。按记录类型给不同页签：助手/用户/上下文 → 概述 · 预览 · 原始内容 · 来源；工具 → 概述 · 参数 · 结果 · Schema · 计时；系统 → 差异 · 系统提示词 · 工具；点请求圆点 → 概述 · 选项 · 用量 · 计时 |

三处实现差异（都不影响观感）：虚拟滚动不用 `@tanstack/react-virtual` 而是自己按
固定行高算窗口；JSON 树与系统提示词差异（上游用 `diff` 的 `structuredPatch`）自己实现；
悬浮提示是自绘浮层而不是上游的 Tooltip 组件。

> **`turn/end` 的 reason 是可辨识联合**（`{kind:'completed'}` / `{kind:'error',error:{…}}` …），
> 不是文档里写的字符串。按字符串判等会让每一轮都误报「本轮运行失败：未知原因」——
> `model.js` 的 `parseTurnReason()` 统一归一，只有 `kind === 'error'` 才报失败。

### 扩展能力与插件接口

控制台里凡是本地 UI 有、协议 v1 没定义的部分，**接口都已经提前定好并接好了**：
**设备能力位探测**，插件报了什么能力，对应 UI 就自动亮起来；没报的整块隐藏。

已经接好的扩展：

| 能力位 | 界面 |
|---|---|
| `sessionEvents` | 轨迹视图、每轮「用时 N 秒」、消息时间戳、步数、tok/s、输入框下方统计条 |
| `messageFeedback` | 助手消息下方的 👍 / 👎 |
| `permissionPresets` | 输入框左侧的权限选择器（只读 / 工作区写 / 完全权限） |
| `agentPresets` | 新会话与会话头的 Agent 预设选择器、设置 → Agent 预设 |
| `attachments` | 输入框的附件按钮、历史消息里的图片与文件卡 |
| `workspaceMutation` | 工作区分组头上的「新建 / 重命名 / 移除」 |
| `fileBrowser` | 右侧栏「文件」 |
| `terminal` | 右侧栏「终端」 |
| `pluginManagement` | 设置 → 插件 |

**完整接口定义（方法名、参数、返回、事件、错误码、优先级）见 [`docs/API.md`](../docs/API.md)。**
`sim/dsh-sim.js` 除了依赖真实 DSH 组合服务的 `agentPresets` 外，把其余扩展都实现了一遍，
可以直接当参考实现读；Agent 预设走真实插件的 `test/extensions.test.js` 覆盖：

```bash
node sim/dsh-sim.js --endpoint https://www.23j1633.xyz:50443/dsh-api
# 模拟器上报全部扩展能力位，控制台里每个面板都有数据可跑
```

> 提权类的扩展（权限预设、Agent 预设写操作、终端、插件启停）默认关闭，需要在
> **设置 → 通用设置 → 高级** 里显式打开。这是刻意的：它们等价于把机器的一部分控制权交出去。

### 做不到的部分

剩下这些协议和扩展都覆盖不到，需要跟**本地 dsh 界面**配合：文档预览、工作区文件的编辑与新建
（只读浏览有了）、图片生成类产物的预览。云端负责「看状态、下指令、答审批」。

---

## 5. 没有真实 dsh 时怎么测

`sim/dsh-sim.js` 是一个按规范实现的**插件侧模拟器**，能顶替真实 dsh 走完整条链路
（hello / 事件 / 方法 / 流式 / 审批 / 断线补发 / HTTP 长轮询），还提供了 `/demo-approval`
这类用于触发审批流的假命令。

```bash
# WebSocket（默认）
node sim/dsh-sim.js --endpoint https://www.23j1633.xyz:50443/dsh-api --name "我的电脑"

# HTTP 长轮询
node sim/dsh-sim.js --endpoint https://www.23j1633.xyz:50443/dsh-api --http

# 其它参数
--key <dshk_…>   显式指定 key（默认首次生成并写入 ~/.dsh-relay/sim-identity.json）
--instance <id>  显式指定 instanceId
--name <名字>    实例显示名
--insecure       跳过 TLS 校验
-v               打印全部收发帧
```

启动后把日志里打印的 key 登记到服务器，控制台里就能看到这台「机器」并真实操作它。

### 测试

```bash
npm test                  # 心跳单元 + 转录回归 + 端到端自检
npm run test:transcript   # 转录装配（纯函数，秒级，无需网络）
npm run selftest          # 端到端协议一致性（起真进程）
```

**转录回归**（23 项）拿两种真实事件形态喂给 `public/js/model.js`，核对产出的对话节点：
工具结果不会被误渲染成用户气泡、工具结果按 `toolCallId` 挂回调用、思考块独立成行、
折叠规则、标准模式不折叠、未知事件透传、节点 key 稳定唯一……夹具是合成的，
但字段名与嵌套结构取自 2026-09-15 从一台真实 dsh（插件 0.1.0）上抓下来的样本。

**一致性自检**（45 项）会真起一个服务器进程 + 多个模拟器进程，逐条核对鉴权、握手、
订阅、方法、流式、审批、断线补发、离线判定、HTTP 长轮询、多机器隔离、key 吊销。

当前状态：**心跳 1/1 + 转录 23/23 + 自检 45/45 全绿**；插件仓库另有真实 Cordis、
浏览器设置页、扩展方法、多端点/双协议与 PHP 后端回归。

### 关于事件形态（踩过的坑）

协议文档 `API.md` §8.6 描述的是**实时原始日志事件**（`turn/start`、`tool/call`、
`tool/result`……）。但真实插件返回的 `session.history` 是另一套东西 —— **消息对齐视图**：
`content` 是内容块数组（`text` / `reasoning` / `tool-call` / `tool-result`），
`seq` 是**页内消息序号**而不是日志序号，`time` 恒为 0，事件带 `synthetic: true`；
工具结果以 `tool-result` 块的形式**挂在 user/message 里**，`toolCallId` 指回调用。

两者都必须支持：冷会话靠 history，实时会话靠事件流。`model.js` 同时处理这两种形态，
`transcript-test.js` 的 A 组 / B 组用例分别盯着它们。

---

## 6. 目录结构

```
dsh-api/
├── server.js              入口：HTTP/HTTPS 监听、路由、WebSocket 升级、证书热重载
├── lib/
│   ├── config.js          配置加载（数据目录在网站根目录之外）
│   ├── log.js             日志（含内存环形缓冲，供调试面板读取）
│   ├── keystore.js        key 白名单：恒定时间比较、指纹、管理密钥
│   ├── link.js            链路抽象：WsLink / HttpLink（两种载体一套协议）
│   ├── instance.js        单台机器的全部内存状态：事件环、会话缓存、请求挂起
│   ├── relay.js           实例表 + 帧分发（两种载体共用）
│   ├── carriers.js        HTTP 长轮询的 /events 与 /inbox
│   └── admin.js           管理 REST + 控制台 SSE
├── public/                前端（静态，无构建步骤）
│   ├── index.html
│   ├── favicon.png        A2S 项目方提供的白底方形应用图标
│   ├── theme.css          dsh 设计 token，逐字取自上游 ui-theme/src/styles/
│   ├── app.css            组件样式，几何尺寸对齐上游各 .module.css
│   ├── trajectory.css     轨迹页样式，逐字取自上游 ui-trajectory/*.module.css
│   ├── js/
│   │   ├── icons.js       78 个图标字形 + 鲸鱼标记 + 官方字标（从上游机械提取）
│   │   ├── util.js        DOM 构建、时间/体积格式化、轻提示
│   │   ├── api.js         dsh-api 客户端（REST + SSE）
│   │   ├── store.js       全局状态与本地偏好
│   │   ├── model.js       转录装配：事件 → 对话节点、工作区分组、状态点
│   │   ├── trajectory-model.js 轨迹数据层（快照 / 分组 / 时间线 / 虚拟行 / 搜索）
│   │   ├── trajectory.js  轨迹视图（工具条 + 时间线 + 账本 + 事件详情）
│   │   ├── markdown.js    markdown 渲染 + 代码高亮 + 终端/diff 块 + 流式冻结
│   │   ├── ui.js          菜单、模态框、设置行等共享控件
│   │   ├── sidebar.js     侧边栏（品牌 / 机器选择 / 会话树 / 底部）
│   │   ├── conversation.js 会话头 + 转录渲染 + 输入框
│   │   ├── settings.js    设置面板（通用 / 机器与密钥 / 插件 / 调试）
│   │   ├── rightbar.js    右侧栏（轨迹 / 文件 / 终端 / 任务）
│   │   └── app.js         外壳装配、事件流、自动刷新、各类操作
│   └── vendor/marked.esm.js
├── sim/dsh-sim.js         插件侧模拟器
├── scripts/
│   ├── selftest.js        端到端协议一致性自检（45 项）
│   └── transcript-test.js 转录装配回归（22 项，纯函数、秒级）
├── PLUGIN-EXT.md          插件接口扩展规范（服务器与真实插件均已接好）
├── start.sh               启停脚本
├── config.example.json    配置样例（生效的是 ~/.dsh-relay/config.json）
└── API.md                 协议规范
```

### 前端资源是怎么来的

上游是 React + 50 多个 `@deepseek-ai/dsh-client-*` 包 + Vite 构建。这里是**零依赖、无构建**
的等价实现，三样东西是机械提取出来的，不手写：

| 资源 | 来源 | 提取方式 |
|---|---|---|
| `public/theme.css` | `packages/client/ui-theme/src/styles/*.css` + `client/web/src/base.css` | 按上游注入顺序原样拼接 |
| `public/js/icons.js` | `packages/client/ui-primitives/src/icons/index.tsx`、`FishLogo.tsx`、`BrandWordmark.tsx` | 解析 TSX，求值属性表达式、展开字符串常量、补回引号后转成纯 SVG 字符串 |
| 组件几何 | 各 `*.module.css`、`ToolRow.tsx`、`ConversationRoot.tsx` 等 | 人工逐项抄写（尺寸、圆角、间距、行高） |

图标与品牌图形是**逐字节**一致的；`theme.css` 是逐字复制，改色只需改这一处。
如果上游升级了设计 token，重新跑一遍提取即可（提取脚本的逻辑写在生成文件头部的注释里）。

---

## 7. 实现清单（对应规范 §12）

- [x] 端点：`/ws`（升级）、`/events`（POST）、`/inbox`（GET），两种载体都实现
- [x] key 白名单：多 key → 多机器、恒定时间比较、持久化、只回显指纹
- [x] 认证：`hello.auth.key` / `Authorization: Bearer` / `?key=` 三种都支持；
      失败发 fatal error 并断开（WS 4401 / HTTP 401；header/query 模式在升级前就拒）
- [x] `hello` → `hello.ack`（带 `resumeFromSeq` 水位），20s 内没等来 hello 主动断开
- [x] `subscribe` / `unsubscribe`：`hello.ack` 之后自动重新订阅，支持逐会话
      `assistantStream`，订阅状态不跨连接保留
- [x] 请求/响应：自增 `id` 匹配、按方法粒度的超时、链路断开时立即失败避免白等
- [x] 事件接收：按 `seq` 去重、环形缓冲 2000 条、超限负载打 `truncated`
- [x] 心跳：回 `pong`，服务器侧另发 WS Ping 双保险
- [x] HTTP 载体：per-instance 待发队列 + 长轮询挂起（`waitMs` 上限 60s），
      `bye` 与 `lastSeenAt` 双路离线判定
- [x] 多机器隔离：一把 key 只能认领一个 instanceId，跨机器串号直接拒绝
- [x] 序号空间重置：插件进程重启导致 `seq` 回退时自动重置缓冲，不会误判成旧事件
- [x] `bridge/resync`：自动重拉 `session.list` + `workspace.list` 并重新订阅
- [x] `autoSubscribe.sessions = "running"`：会话开始干活时自动补订阅逐条事件与流式输出
- [x] 前端：dsh 本地 UI 的复刻（侧边栏 / 转录 / 输入框 / 设置），实时事件流 + 自动刷新
- [x] 前端：轨迹页逐字复刻（工具条 / 时间线 / 账本 / 事件详情），见「4. 界面 → 轨迹页」
- [x] 管理面：key 的补登 / 编辑（改名、换 key）/ 吊销，编辑即时同步到在线实例
      双层同步，深色主题，零构建步骤

## 8. 安全须知

1. **证书**：复用站点私钥 `/opt/1panel/www/sites/Main/ssl/privkey.pem`（本进程读得到，
   该文件是 0644）。证书续期后进程会自动热重载（每 10 分钟检查一次 mtime），不用重启。
2. **key 只存白名单，不进日志**：日志与界面只出现指纹 `dshk_AbCdEf…9xYz`。
3. **数据目录在网站根目录之外**：`index/` 整个目录是 nginx 公网静态服务的，
   把 `keys.json` 放进去等于把凭据公开。如果你要改 `dataDir`，务必保持这个约束。
4. **`dsh-api/` 源码本身是可公网读取的**（例如
   `https://www.23j1633.xyz/dsh-api/server.js`）。里面不含任何凭据，但如果你想彻底屏蔽，
   在 1Panel 给 Main 站点加一条拒绝规则即可（我没有 root，改不了 nginx 配置）：

   ```nginx
   location ^~ /dsh-api/ { return 404; }
   ```

   加了也不影响功能——插件连的是 `:50443`，不是站点的 443。
5. **管理密钥等于「向所有机器下发命令」的权限**，`admin-key.txt` 是 0600，别外传。
6. **审批转发**：是否把本机审批送到服务器由插件侧 `forwardApprovals` 决定，默认关闭。
   打开意味着「服务器上的一个人可以批准本机工具调用」，请自行评估信任边界。

---

## English

This directory is the legacy single-Agent `dsh-api` reference server and compatibility console. New A2S deployments should use the top-level `server-api`, which supports Claude, Codex, and DSH under one device key and still accepts the `/dsh-api` alias.

### Endpoints and deployment

The Node server implements protocol v1 over WebSocket plus HTTP long polling and serves its management console. It can run directly with Node or under the included Linux startup/service examples. Configure host, port, data directory, TLS certificate/key, and an administrator key through its documented environment/configuration fields. Public deployments require HTTPS/WSS.

Agent-facing endpoints cover WebSocket, event upload, inbox polling, and health. Management endpoints cover keys, instances, sessions, workspaces, requests, events, and service logs. Management credentials belong in `x-admin-key`, never in query strings.

### Pairing

Generate or obtain the DSH instance key locally, then register it through the console or key API using the server administrator key. The instance appears after its outbound connection succeeds. Removing or rotating the registered key prevents later reconnects until the replacement is registered.

### Console

The legacy UI mirrors the DSH workflow: instance/session/workspace selection, conversation history, live assistant/tool trajectory, prompt input, interrupt/pause/resume, approvals/questions, model and permission controls, tasks/goals, files, plugins, and diagnostic methods when the connected plugin advertises them. Events use sequence watermarks and backlog loading so a page refresh can recover recent activity.

The simulator can exercise both WebSocket and HTTP carriers and advertise the extended capability set, allowing UI development without a real DSH host. Source and test commands are documented in the Chinese section above.

### Security and limitations

- This is retained for standalone DSH compatibility, not the recommended multi-Agent production server.
- Protect `admin-key.txt` and key allowlists with restrictive filesystem permissions and never publish them.
- The server-side source contains no credentials, but exposing source directories through a static Web root is unnecessary and can be blocked by the Web server.
- `forwardApprovals` is disabled by default. Enabling it allows a remote operator to approve local tool execution and changes the trust boundary.
- Keep the Agent port behind TLS and firewall policy; workstation machines still require no inbound ports.
