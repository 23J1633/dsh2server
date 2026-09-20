/* 会话转录模型。
 *
 * 上游 dsh 的对话区是「按 turn 把持久事件折成 Chat 节点」：ui-conversation 负责
 * 装配，ui-chat 负责节点定义与渲染。这里做同样的事，只是输入换成了 dsh-api 转发
 * 过来的 session/event 原始事件（协议 §8.6 明确要求原样转发、未知类型透传忽略）。
 *
 * 事件字段取自协议 §8.6 的表述，并对真实插件可能的几种写法做了容错——
 * 未知结构一律落到 generic 节点，绝不断流。
 */

/**
 * @typedef {object} TranscriptNode
 * @property {string} kind 节点类型
 * @property {string} key React 式的稳定标识（上游用 anchorSeq 派生）
 * @property {number} seq 锚定的事件序号
 * @property {number} time epoch ms
 */

const PROCESS_INDEPENDENT = new Set([
  'user', 'steering', 'turn-error', 'turn-max-tokens', 'turn-process', 'turn-files',
]);

/** 轮次结束原因（TurnEndReason）→ 徽标文案 */
const TURN_REASON_LABELS = {
  completed: '完成',
  aborted: '已中断',
  blocked: '已阻塞',
  error: '出错',
  'max-tokens': '超出上限',
  interrupted: '异常中断',
};

/**
 * 归一化 `turn/end` 的 `reason`。
 *
 * 真实 dsh 的 `TurnEndReason` 是**可辨识联合**（`packages/core/session/src/types.ts`
 * 的 `TurnEndReasonMap`）：
 *   `{kind:'completed'}` / `{kind:'aborted', reason:{kind:…}}` /
 *   `{kind:'error', error:{code,message}}` / `{kind:'max-tokens'}` /
 *   `{kind:'blocked'}` / `{kind:'interrupted'}`
 * 而 PLUGIN-EXT.md 里写的是字符串形态（`"completed"`）。两种都得认：
 * 只按字符串判等会得到「所有轮次都失败 + 原因未知」这种误报。
 *
 * @param {any} reason 原始 reason，可能已经是本函数的返回值
 * @returns {{kind: string, message: string, code: string|null}}
 */
export function parseTurnReason(reason) {
  if (reason == null || reason === '') return { kind: 'completed', message: '', code: null };
  if (typeof reason === 'string') return { kind: reason, message: '', code: null };
  if (typeof reason !== 'object') return { kind: 'completed', message: '', code: null };

  const kind = typeof reason.kind === 'string' && reason.kind
    ? reason.kind
    : (typeof reason.code === 'string' && reason.code ? reason.code : 'unknown');
  // `{kind:'error', error:{code,message}}` 里 error 才是 LlmFailure 原文
  const failure = reason.error && typeof reason.error === 'object' ? reason.error : reason;
  const code = typeof failure.code === 'string' && failure.code ? failure.code
    : (typeof reason.code === 'string' && reason.code ? reason.code : null);
  const message = typeof failure.message === 'string' ? failure.message : '';
  return { kind, message, code };
}

/**
 * 轮次结束原因的可读短文案，用于轮次徽标。
 * @param {any} reason
 * @returns {string}
 */
export function turnReasonLabel(reason) {
  const { kind } = parseTurnReason(reason);
  return TURN_REASON_LABELS[kind] || kind;
}

/**
 * 这一轮的结束原因是否需要提示（`completed` 以外都算非正常结束）。
 * @param {any} reason
 */
export function isAbnormalTurnEnd(reason) {
  return parseTurnReason(reason).kind !== 'completed';
}

/**
 * 终止性失败：只有 `kind === 'error'` 才是「本轮运行失败」，
 * 对应上游 ui-chat 的 `turn-error` 节点；aborted / interrupted / blocked
 * 都不该报错，max-tokens 另有专门提示。
 * @param {any} reason
 */
export function isTurnFailure(reason) {
  return parseTurnReason(reason).kind === 'error';
}

/** 一轮对话里，可以折进「过程」的节点类型 */
const FOLDABLE = new Set(['assistant-step', 'tool', 'reasoning']);

/**
 * 从 data 里尽量取出消息文本。
 *
 * 真实 dsh 有两种写法，都要认：
 *   · session.history 的消息对齐记录 —— content 是内容块数组
 *     `[{type:'text',text}] / [{type:'reasoning',text}] / [{type:'tool-call',...}]`
 *   · 实时 session/event —— 消息体可能是字符串
 * @param {any} data
 * @returns {string}
 */
function messageText(data) {
  const m = data?.message ?? data;
  const c = m?.content ?? m?.text ?? data?.text ?? data?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // 只取纯文本块；reasoning / tool-call / tool-result 由各自的节点渲染
    return c.filter((b) => !b?.type || b.type === 'text')
      .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
      .join('');
  }
  if (c && typeof c === 'object') return c.text ?? '';
  return '';
}

/** 取一条消息的内容块数组；不是块数组就返回 null */
function blocksOf(data) {
  const c = data?.message?.content ?? data?.content;
  return Array.isArray(c) ? c : null;
}

/** 工具结果块的文本（content 也是块数组） */
function blockResultText(block) {
  const c = block?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('');
  if (c && typeof c === 'object') return c.text ?? '';
  return '';
}

/** 解析工具调用参数（协议里是原始 JSON 字符串） */
function toolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { _raw: String(raw) }; }
}

/**
 * 把内容块（可能嵌套 ToolResultBlock）折成纯文本。
 * 真实插件的 `tool/result.message` 是 ToolResultMessage：
 * `{role:'user', content:[{type:'tool-result', content:[{type:'text',text}]}]}`，
 * 文本在第二层，直接取 `m.content` 会拿到一个数组。
 */
function blocksToText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(blocksToText).join('');
  if (value && typeof value === 'object') {
    if (value.type === 'tool-result') return blocksToText(value.content);
    return value.text ?? '';
  }
  return '';
}

/** 工具结果文本 */
function resultText(data) {
  const m = data?.message ?? data?.result ?? data?.content;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return blocksToText(m);
  if (m && typeof m === 'object') return m.text ?? blocksToText(m.content);
  return '';
}

/** 工具结果是否标了失败：`d.error` 或内容块上的 isError */
function resultError(data) {
  const m = data?.message ?? data?.result ?? data?.content;
  const first = Array.isArray(m?.content) ? m.content[0] : Array.isArray(m) ? m[0] : null;
  if (first?.isError === true) return data?.error ?? { message: '工具执行失败' };
  return data?.error ?? null;
}

/**
 * 把一串会话事件折成可渲染的节点流。
 *
 * @param {Array<{type: string, seq: number, time: number, data: any}>} events 按 seq 升序的持久事件
 * @param {{text?: string, streaming?: boolean}|null} live 正在进行的流式输出（尚未落成 assistant/message）
 * @param {{compact?: boolean, openTurns?: Set<number>}} [opts]
 *        compact 对应设置里的「对话显示：紧凑」，开启后已结束的轮次会把中间步骤折起来；
 *        openTurns 是用户手动展开过的轮次集合。
 * @returns {TranscriptNode[]}
 */
export function buildTranscript(events, live, opts = {}) {
  const compact = opts.compact !== false;
  const openTurns = opts.openTurns || new Set();

  /** @type {Map<number, {turn: number, nodes: TranscriptNode[], closed: boolean, reason: string|null, startTime: number|null, endTime: number|null}>} */
  const turns = new Map();
  const turnOrder = [];
  const toolByCallId = new Map();
  let current = null;
  let turnNo = 0;
  let seqNo = 0;

  const turnOf = (n) => {
    if (!turns.has(n)) {
      turns.set(n, { turn: n, nodes: [], closed: false, reason: null, startTime: null, endTime: null });
      turnOrder.push(n);
    }
    return turns.get(n);
  };

  const openTurn = () => {
    turnNo += 1;
    current = turnOf(turnNo);
    return current;
  };

  const here = () => current || openTurn();

  // 消息对齐记录的 seq 全是 0（合成记录），需要一个稳定且唯一的序号做节点 key
  const nextSeq = () => { seqNo += 1; return seqNo; };
  const keySeq = (ev) => (Number.isInteger(ev.seq) && ev.seq > 0 ? `e${ev.seq}` : `s${nextSeq()}`);

  /** 把工具结果挂回对应的调用 */
  const attachResult = (callId, text, error, meta = null) => {
    const node = toolByCallId.get(callId);
    if (!node) return false;
    node.result = { text, error: error ?? null, meta };
    node.state = error ? (error.code === 'interrupted' ? 'stopped' : 'error') : 'ok';
    return true;
  };

  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue;
    const d = ev.data || {};
    const n = Number.isFinite(d.turn) ? d.turn : (current ? current.turn : 0);

    switch (ev.type) {
      case 'turn/start': {
        current = turnOf(Number.isFinite(d.turn) ? d.turn : ++turnNo);
        current.startTime = Number.isFinite(ev.time) ? ev.time : null;
        break;
      }

      case 'user/message': {
        // 消息对齐记录：内容块数组。带 tool-result 块的属于「派生」消息，
        // 它是工具结果回灌，不是人说的话，绝不能渲染成用户气泡。
        const blocks = blocksOf(d);
        const text = messageText(d);
        if (blocks) {
          for (const b of blocks) {
            if (b?.type === 'tool-result') {
              const callId = String(b.toolCallId ?? b.callId ?? '');
              if (!attachResult(callId, blockResultText(b), b.isError ? { message: '工具执行失败' } : null, b.meta ?? null)) {
                const t = here();
                t.nodes.push({
                  kind: 'tool', key: `tool:${callId || keySeq(ev)}`, seq: nextSeq(), time: ev.time,
                  turn: t.turn, callId: callId || `orphan-${nextSeq()}`, name: 'tool-result', args: {},
                  result: { text: blockResultText(b), error: b.isError ? { message: '工具执行失败' } : null, meta: b.meta ?? null },
                  state: b.isError ? 'error' : 'ok',
                });
              }
            }
          }
        }
        if (!blocks || text.trim()) {
          // 有真实文本才算人类发言；只有 tool-result 块的记录跳过
          // 原始 DSH 日志里的 user/message 常不带 data.turn，却位于已经开始的
          // turn 中；只有消息对齐历史（没有 turn/start）才需要在此新开一轮。
          const t = Number.isFinite(d.turn)
            ? turnOf(d.turn)
            : (current?.startTime != null && !current.closed ? current : (blocks ? openTurn() : turnOf(n)));
          t.nodes.push({
            kind: 'user', key: `user:${keySeq(ev)}`, seq: nextSeq(), logSeq: ev.seq, time: ev.time,
            turn: t.turn, text: blocks ? text : messageText(d),
          });
        }
        break;
      }

      case 'assistant/message': {
        const blocks = blocksOf(d);
        const t = here();
        if (blocks) {
          let text = '';
          for (const b of blocks) {
            if (b?.type === 'reasoning' && String(b.text || '').trim()) {
              t.nodes.push({
                kind: 'reasoning', key: `think:${keySeq(ev)}`, seq: nextSeq(), time: ev.time,
                turn: t.turn, text: String(b.text),
              });
            } else if (b?.type === 'tool-call') {
              const callId = String(b.id ?? b.callId ?? `call-${nextSeq()}`);
              const node = {
                kind: 'tool', key: `tool:${callId}`, seq: nextSeq(), logSeq: ev.seq, time: ev.time, turn: t.turn,
                callId, name: String(b.name ?? 'tool'), args: toolArgs(b.arguments ?? b.args),
                description: b.description ?? null, summary: b.summary ?? null,
                result: null, state: 'running',
              };
              toolByCallId.set(callId, node);
              t.nodes.push(node);
            } else if (b?.type === 'text') {
              text += String(b.text ?? '');
            }
          }
          if (text.trim()) {
            t.nodes.push({
              kind: 'assistant-step', key: `step:${keySeq(ev)}`, seq: nextSeq(), logSeq: ev.seq, time: ev.time, turn: t.turn,
              step: t.nodes.length + 1, text, usage: d.usage ?? null,
              interrupted: !!d.interrupted, streaming: false,
            });
          }
        } else {
          t.nodes.push({
            kind: 'assistant-step', key: `step:${keySeq(ev)}`, seq: nextSeq(), logSeq: ev.seq, time: ev.time, turn: t.turn,
            step: Number.isFinite(d.step) ? d.step : (t.nodes.length + 1),
            text: messageText(d), usage: d.usage ?? null,
            interrupted: !!d.interrupted, streaming: false,
          });
        }
        break;
      }

      case 'tool/call': {
        const t = here();
        const callId = String(d.callId ?? d.id ?? `call-${nextSeq()}`);
        // 真实日志里 `tool/call` 与带 tool-call 块的 `assistant/message` 是两条事件，
        // 说的是同一次调用；先到的那条建了节点，后到的这条不能再建一个。
        if (toolByCallId.has(callId)) break;
        const node = {
          kind: 'tool', key: `tool:${callId}`, seq: nextSeq(), logSeq: ev.seq, time: ev.time, turn: t.turn,
          callId, name: String(d.name ?? d.tool ?? 'tool'),
          args: toolArgs(d.arguments ?? d.args),
          description: d.description ?? null, summary: d.summary ?? null,
          result: null, state: 'running',
        };
        toolByCallId.set(callId, node);
        t.nodes.push(node);
        break;
      }

      case 'tool/result': {
        const callId = String(d.callId ?? d.id ?? '');
        const failure = resultError(d);
        if (!attachResult(callId, resultText(d), failure, d.meta ?? null)) {
          // 结果先于调用到达（历史窗口被截断）：落成独立节点，别丢信息
          const t = here();
          t.nodes.push({
            kind: 'tool', key: `tool:${callId || keySeq(ev)}`, seq: nextSeq(), time: ev.time, turn: t.turn,
            callId: callId || `orphan-${nextSeq()}`, name: 'tool-result', args: {},
            result: { text: resultText(d), error: failure, meta: d.meta ?? null },
            state: failure ? 'error' : 'ok',
          });
        }
        break;
      }

      case 'step/start':
      case 'step/end':
      case 'request/header':
      case 'request/context':
      case 'session/end-seed':
        break; // 结构性事件，转录里不单独成行

      case 'turn/end': {
        const t = turnOf(n);
        t.closed = true;
        t.endTime = Number.isFinite(ev.time) ? ev.time : null;
        t.reason = parseTurnReason(d.reason);
        if (Array.isArray(d.files)) t.files = d.files;
        // 只有 kind==='error' 才落「本轮运行失败」；max-tokens 单独一条提示；
        // aborted / interrupted / blocked 是正常终止，不打扰用户（与上游一致）。
        if (t.reason.kind === 'error') {
          t.nodes.push({
            kind: 'turn-error', key: `turnerr:${keySeq(ev)}`, seq: nextSeq(), time: ev.time,
            turn: n, reason: t.reason,
          });
        } else if (t.reason.kind === 'max-tokens') {
          t.nodes.push({
            kind: 'turn-max-tokens', key: `turnmaxtok:${keySeq(ev)}`, seq: nextSeq(), time: ev.time,
            turn: n, reason: t.reason,
          });
        }
        break;
      }

      default:
        break; // 未知类型：忽略，不断流（协议 §8.6）
    }
  }

  if (live && (live.text || live.streaming)) {
    const t = here();
    t.nodes.push({
      kind: 'assistant-step', key: 'live', seq: Number.MAX_SAFE_INTEGER, time: Date.now(),
      turn: t.turn, step: Number.MAX_SAFE_INTEGER, text: live.text || '',
      usage: null, interrupted: false, streaming: true,
    });
  }

  const list = turnOrder.map((n) => turns.get(n));
  for (const turn of list) {
    if (turn.startTime == null || turn.endTime == null) continue;
    const durationMs = Math.max(0, turn.endTime - turn.startTime);
    for (const node of turn.nodes) {
      if (node.kind === 'assistant-step') node.durationMs = durationMs;
    }
  }
  // 消息对齐记录没有 turn/end，用「会话是否在运行」推断最后一轮有没有结束
  for (let i = 0; i < list.length; i += 1) {
    if (!list[i].closed && (i < list.length - 1 || opts.running === false)) list[i].closed = true;
  }

  // 每一轮末尾补一行「本轮文件改动」（插件给了 turn/end.data.files 就用插件的，否则从工具调用推导）
  for (const t of list) {
    const raw = t.files?.length ? t.files : changedFiles(t.nodes);
    const files = raw.map(normalizeFile).filter(Boolean);
    if (files.length) {
      t.nodes.push({ kind: 'turn-files', key: `files:${t.turn}`, seq: Number.MAX_SAFE_INTEGER - 1, time: null, turn: t.turn, files });
    }
  }

  return flatten(list, { compact, openTurns });
}

/**
 * 逐轮决定是否折叠中间过程。
 * 规则与上游一致：只折「已结束的轮次」里的过程节点，最终答案永不折；
 * 用户消息等独立节点不受影响。
 */
function flatten(turns, { compact, openTurns }) {
  const out = [];
  for (const t of turns) {
    const answerIndex = lastAnswerIndex(t.nodes);
    const foldable = compact && t.closed && answerIndex > 0 && t.nodes.slice(0, answerIndex).some((n) => FOLDABLE.has(n.kind));

    if (!foldable) {
      for (const n of t.nodes) out.push(n);
      continue;
    }

    const open = openTurns.has(t.turn);
    const processNodes = [];
    let toolCalls = 0;
    let messages = 0;
    for (let i = 0; i < answerIndex; i += 1) {
      const n = t.nodes[i];
      if (PROCESS_INDEPENDENT.has(n.kind)) { out.push(n); continue; }
      if (!FOLDABLE.has(n.kind)) { out.push(n); continue; }
      processNodes.push(n);
      if (n.kind === 'tool') toolCalls += 1;
      if (n.kind === 'assistant-step') messages += 1;
    }

    const head = processNodes[0] || t.nodes[answerIndex];
    out.push({
      kind: 'turn-process',
      key: `process:${t.turn}:${head.seq}`,
      seq: head.seq,
      time: head.time,
      turn: t.turn,
      toolCalls,
      messages,
      open,
    });

    // 过程节点始终留在 DOM 里（用 hidden 收起），这样 Ctrl+F 能穿透展开，
    // 与上游 useSearchableHidden / hidden="until-found" 的行为一致。
    for (const n of processNodes) out.push({ ...n, member: true, hidden: !open });

    for (let i = answerIndex; i < t.nodes.length; i += 1) {
      out.push({ ...t.nodes[i], answer: true, member: false });
    }
  }
  return out;
}

function lastAnswerIndex(nodes) {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (nodes[i].kind === 'assistant-step' && !nodes[i].streaming) return i;
  }
  return -1;
}

/**
 * 归一一条「文件改动」记录。
 * 插件给的 `turn/end.data.files` 只有 `{path, added, removed}`，没带文件名，
 * 渲染时要用 name，所以在这里补齐；两种来源（插件 / 工具推导）产出同一种形状。
 * @param {{path?:string, name?:string, added?:number, removed?:number}} f
 * @returns {{path:string, name:string, added:number|null, removed:number|null}|null}
 */
function normalizeFile(f) {
  const path = f?.path;
  if (!path) return null;
  return {
    path: String(path),
    name: f.name || String(path).split(/[\\/]/).filter(Boolean).pop() || String(path),
    added: f.added ?? null,
    removed: f.removed ?? null,
  };
}

/**
 * 从原始事件窗口里算出每一轮的统计（时长、步数、输出 token）。
 *
 * 数据源是 `session.events`（见 PLUGIN-EXT.md §1）或实时 `session/event`；
 * 没有原始事件时返回空数组，界面自动降级。
 * @param {Array<{type:string,seq:number,time:number,data:any}>} trace
 * @returns {Array<{turn:number, startedAt:number|null, endedAt:number|null, durationMs:number|null,
 *                  steps:number, outputTokens:number, toolCalls:number, reason:string|null, tokPerSec:number|null}>}
 */
export function turnStats(trace) {
  const byTurn = new Map();
  const of = (n) => {
    if (!byTurn.has(n)) {
      byTurn.set(n, {
        turn: n, startedAt: null, endedAt: null, durationMs: null,
        steps: 0, outputTokens: 0, toolCalls: 0,
        reason: parseTurnReason(null), tokPerSec: null,
      });
    }
    return byTurn.get(n);
  };

  for (const ev of trace || []) {
    const d = ev?.data || {};
    const n = Number.isFinite(d.turn) ? d.turn : null;
    switch (ev?.type) {
      case 'turn/start':
        if (n != null) of(n).startedAt = ev.time || null;
        break;
      case 'step/start': {
        if (n == null) break;
        const t = of(n);
        t.steps += 1;
        if (t.startedAt == null && ev.time) t.startedAt = ev.time;
        break;
      }
      case 'tool/call':
        if (n != null) of(n).toolCalls += 1;
        break;
      case 'assistant/message':
        if (n == null) break;
        of(n).outputTokens += Number(d.usage?.outputTokens ?? d.usage?.completion_tokens ?? 0);
        break;
      case 'turn/end': {
        if (n == null) break;
        const t = of(n);
        t.endedAt = ev.time || null;
        t.reason = parseTurnReason(d.reason);
        break;
      }
      default:
        break;
    }
  }

  const list = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  for (const t of list) {
    if (t.startedAt != null && t.endedAt != null && t.endedAt > t.startedAt) {
      t.durationMs = t.endedAt - t.startedAt;
      if (t.outputTokens > 0) t.tokPerSec = t.outputTokens / (t.durationMs / 1000);
    }
  }
  return list;
}

/**
 * 本轮改动过的文件，用于轮次末尾的「本轮文件改动」行。
 * 数据来自该轮里的 write / edit 工具调用；插件若在 `turn/end.data.files` 里
 * 直接给出（PLUGIN-EXT.md §9.2），优先用插件的。
 * @param {Array} nodes 该轮的对话节点
 * @returns {Array<{path:string, name:string, added:number|null, removed:number|null}>}
 */
export function changedFiles(nodes) {
  const seen = new Map();
  for (const n of nodes || []) {
    if (n.kind !== 'tool') continue;
    if (n.name !== 'write' && n.name !== 'edit') continue;
    const path = n.args?.file_path || n.args?.path || n.args?.filePath;
    if (!path) continue;
    const added = n.result?.meta?.added ?? n.result?.meta?.insertions ?? null;
    const removed = n.result?.meta?.removed ?? n.result?.meta?.deletions ?? null;
    const prev = seen.get(path);
    seen.set(path, {
      path,
      name: String(path).split(/[\\/]/).filter(Boolean).pop() || String(path),
      added: added == null ? prev?.added ?? null : (prev?.added ?? 0) + added,
      removed: removed == null ? prev?.removed ?? null : (prev?.removed ?? 0) + removed,
    });
  }
  return [...seen.values()];
}

/**
 * 按上游工作区注册表分组，对应本地 Sidebar 的会话树。
 *
 * 注册表存在时以 `workspace.sessionIds` 为准；路径只用于显示。这样旧会话、
 * Windows 斜杠差异和同名目录都不会伪造出重复工作区。未被任何工作区认领的
 * 会话统一进入「未分组」。没有注册表时才退回按 cwd 分组。
 * @param {Array} sessions session.list 的 items
 * @param {Array} [workspaces] workspace.list 的 items
 * @returns {Array<{key: string, cwd: string|null, label: string, workspaceId?: string, sessions: Array}>}
 */
export function groupByCwd(sessions, workspaces = []) {
  if (Array.isArray(workspaces) && workspaces.length) {
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const claimed = new Set();
    const groups = workspaces.map((workspace, index) => {
      const rows = [];
      for (const sessionId of workspace.sessionIds || []) {
        const session = byId.get(sessionId);
        if (!session) continue;
        claimed.add(sessionId);
        rows.push(session);
      }
      rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const cwd = workspace.path || null;
      return {
        key: `workspace:${workspace.id || workspace.workspaceId || cwd || index}`,
        workspaceId: workspace.id || workspace.workspaceId,
        cwd,
        label: workspace.title || (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : '') || '工作区',
        sessions: rows,
      };
    });
    const ungrouped = sessions
      .filter((session) => !claimed.has(session.sessionId))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (ungrouped.length) groups.push({ key: '', cwd: null, label: '未分组', sessions: ungrouped });
    return groups;
  }

  const groups = new Map();
  for (const s of sessions) {
    const cwd = s.cwd || null;
    // Windows 会话可能交替上报反斜杠、正斜杠或不同大小写；本地 UI
    // 会把它们视为同一个目录，服务端也要合并，避免同名重复项目组。
    const key = cwd ? cwd.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLocaleLowerCase() : '';
    if (!groups.has(key)) groups.set(key, { key, cwd, sessions: [] });
    groups.get(key).sessions.push(s);
  }
  const list = [...groups.values()];
  for (const g of list) {
    g.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    g.label = g.cwd ? g.cwd.split(/[\\/]/).filter(Boolean).pop() || g.cwd : '未分组';
  }
  list.sort((a, b) => {
    if (a.cwd === null) return 1;
    if (b.cwd === null) return -1;
    return (b.sessions[0]?.updatedAt || 0) - (a.sessions[0]?.updatedAt || 0);
  });
  return list;
}

/**
 * 会话标题。
 *
 * 真实插件的标题在 `projections.values.title` 里（`session.list` 的 items 上
 * `projections` 常为空对象，只有 `session.get` / `session/snapshot` 才带），
 * 所以两个位置都要看。
 * @param {object} s 会话摘要或 session.get 结果
 * @returns {string}
 */
export function sessionTitle(s) {
  const t = s?.title ?? s?.projections?.values?.title;
  if (t) return String(t);
  if (s?.blank) return '新会话';
  return s?.sessionId || '';
}

/**
 * 从会话快照里取 token 统计（真实插件的形状见 PLUGIN-EXT.md §1）。
 * @param {object} values `projections.values`
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number, total:number, cacheHit:number|null}|null}
 */
export function tokenStats(values) {
  const u = values?.tokenUsage;
  if (!u) return null;
  const input = Number(u.uncachedInputTokens ?? u.inputTokens ?? 0);
  const output = Number(u.outputTokens ?? 0);
  const cacheRead = Number(u.cacheReadTokens ?? 0);
  const cacheWrite = Number(u.cacheWriteTokens ?? 0);
  const total = input + output + cacheRead + cacheWrite;
  if (!total) return null;
  // 缓存命中率：读缓存 / (读缓存 + 未缓存输入)
  const denom = cacheRead + input;
  return { input, output, cacheRead, cacheWrite, total, cacheHit: denom > 0 ? cacheRead / denom : null };
}

/** 数字缩写：1234 → 1.2k，1234567 → 1.2M */
export function shortNum(n) {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

/** 时长：43 秒 / 2 分 10 秒 / 1 小时 3 分 */
export function humanDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/**
 * 会话状态点，优先级与上游 sessionStatuses 一致。
 * @returns {{state: 'approval'|'question'|'ongoing'|'done', label: string}}
 */
export function sessionStatus(s, detail) {
  const decisions = detail?.pendingDecisions || [];
  const mine = decisions.filter((d) => !d.sessionId || d.sessionId === s.sessionId);
  if (mine.some((d) => d.kind === 'approval')) return { state: 'approval', label: '等待审批' };
  if (mine.some((d) => d.kind === 'question')) return { state: 'question', label: '等待回答' };
  if (s.running) return { state: 'ongoing', label: '运行中' };
  return { state: 'done', label: '空闲' };
}
