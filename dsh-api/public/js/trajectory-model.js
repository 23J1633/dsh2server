/* 轨迹视图的数据层。
 *
 * 逐字移植自 deepseek-harness 的 `packages/client/ui-trajectory/src/client`：
 *   · trajectory-record.ts        → 记录契约与时长格式化
 *   · trajectory-event-projection → 事件 → 视图对象的投影
 *   · trajectory-*-definition.ts  → 各节点的事件状态机（这里合并成一次顺序扫描）
 *   · trajectory-snapshot-builder → 事件节点 / 请求 / 系统提示词快照
 *   · layout.ts                   → turn → 消息/步骤 分组，展开成可渲染的 cell
 *   · timeline.ts                 → 时间线投影（操作序 / 真实时长）
 *   · trajectory-virtual-rows.ts  → 虚拟滚动行
 *   · trajectory-search-index.ts  → 账本全文搜索
 *   · trajectory-preview.ts       → Markdown → 单行预览
 *   · locales.ts                  → 中文文案（键名与上游一致）
 *
 * 差异只有一处：上游的输入是 Cordis 装配出来的 ConversationMatch（带 location、
 * surfaceOp 等），这里直接吃插件经 `session.events` 给的原始事件数组。
 * 事件字段一律按 `packages/core/session/src/types.ts` 的 SessionEventMap 读，
 * 并保留对更简写法的容错——未知结构落到兜底分支，绝不断流。
 */
import { markdownFragment } from './markdown.js';

// ---------------------------------------------------------------- 文案

/** 轨迹命名空间的中文字典，键名与上游 locales.ts 完全一致。 */
export const ZH = {
  'view.trajectory': '轨迹',
  'toolbar.aria': '轨迹工具栏',
  'toolbar.duration': '时长',
  'toolbar.useActualDuration': '使用实际时长',
  'toolbar.useEqualWidth': '使用等宽操作',
  'toolbar.actualTime': '实际时间',
  'toolbar.turns': '轮次',
  'toolbar.expandTurns': '展开所有轮次',
  'toolbar.collapseTurns': '收起所有轮次',
  'toolbar.calls': '调用',
  'toolbar.expandCalls': '展开所有调用',
  'toolbar.collapseCalls': '收起所有调用',
  'toolbar.search': '搜索轨迹',
  'toolbar.searchPlaceholder': '搜索',
  'kind.system': '系统',
  'kind.user': '用户',
  'kind.context': '上下文',
  'kind.compacted': '已压缩',
  'kind.message': '消息',
  'kind.assistant': '助手',
  'kind.tool': '工具',
  'kind.subtool': '子工具',
  'kind.sub': '子项',
  'column.input': '输入',
  'column.output': '输出',
  'column.think': '思考',
  'column.time': '时间',
  'column.model': '模型',
  'column.tools': '工具',
  'turn.label': '第 {turn} 轮',
  'section.betweenTurns': '轮次之间',
  'group.message': '消息',
  'group.step': '步骤 {step}',
  'group.compaction': '压缩 {seq}',
  'status.failed': '失败',
  'status.pending': '等待中',
  'status.completed': '已完成',
  'timing.notAvailable': '不可用',
  'timing.notRecorded': '未记录',
  'timing.stepStartUnavailable': '步骤开始时间不可用',
  'timing.firstTokenUnavailable': '首 token 时间不可用',
  'timing.usageUnavailable': '用量不可用',
  'timing.outputTokensUnavailable': '输出 token 数不可用',
  'timing.durationTooShort': '时长过短',
  'timing.showLocalTime': '显示本地时间',
  'timing.showUnixTimestamp': '显示 Unix 时间戳',
  'timing.started': '开始时间',
  'timing.totalDuration': '总时长',
  'timing.ttft': '首 token 延迟',
  'timing.generation': '生成',
  'timing.throughput': '吞吐量',
  'timing.duration': '时长',
  'timing.source': '计时来源',
  'timing.sessionTimestamps': '会话时间戳',
  'timing.sessionTimestampsRunning': '会话时间戳（运行中）',
  'timing.request': '请求计时',
  'unit.milliseconds': '{value} 毫秒',
  'unit.seconds': '{value} 秒',
  'unit.tokens': '{value} tok',
  'unit.tokensPerSecond': '{value} tok/s',
  'usage.tokens': 'Token',
  'usage.reasoning': '推理',
  'usage.content': '内容',
  'usage.notReported': '未报告用量',
  'usage.input': '输入',
  'usage.cached': '缓存读取',
  'usage.cacheCreated': '缓存写入',
  'usage.other': '其他',
  'usage.output': '输出',
  'usage.thisRequest': '本次请求',
  'usage.sessionCumulative': '会话累计',
  'options.notRecorded': '未记录选项',
  'options.json': '请求选项 JSON',
  'source.unknown': '未知',
  'source.user': '用户',
  'source.plugin': '插件',
  'source.pluginNamed': '插件 · {plugin}',
  'source.goal': '目标',
  'source.goalRound': '目标 · Round {round}',
  'source.notRecorded': '未记录来源',
  'source.messageJson': '消息来源 JSON',
  'tab.summary': '概述',
  'tab.rawOutput': '原始输出',
  'tab.preview': '预览',
  'tab.raw': '原始内容',
  'tab.source': '来源',
  'tab.payload': '参数',
  'tab.result': '结果',
  'tab.schema': 'Schema',
  'tab.timing': '计时',
  'tab.diff': '差异',
  'tab.systemPrompt': '系统提示词',
  'tab.tools': '工具',
  'tab.options': '选项',
  'tab.usage': '用量',
  'record.toolCallOnly': '（仅工具调用）',
  'record.noContent': '无内容',
  'record.noPayload': '未捕获参数',
  'record.noResult': '未捕获结果',
  'record.noOutput': '无输出',
  'record.schemaUnavailable': 'Schema 不可用',
  'record.parameters': '参数',
  'record.resultJson': '结果 JSON',
  'record.json': 'JSON',
  'record.parametersJson': '参数 JSON',
  'record.namedParametersJson': '{name} 参数 JSON',
  'record.payloadJson': '参数 JSON',
  'record.outputJson': '结果 JSON',
  'record.thinking': '思考',
  'record.systemPromptMissing': '本次请求没有系统提示词',
  'record.toolsMissing': '本次请求没有工具',
  'record.systemPrompt': '系统提示词',
  'record.tools': '工具',
  'block.openSummary': '打开第 {index} 个块的工具调用概述',
  'block.openSummaryTitle': '打开工具调用概述',
  'block.label': '块 #{index} {type}',
  'history.loadingTrajectory': '正在加载轨迹…',
  'history.loadingEarlier': '正在加载更早的历史…',
  'history.loadingEarlierAria': '正在加载更早的历史…',
  'history.loadEarlier': '加载更早的历史',
  'history.clickToLoadEarlier': '点击加载更早的历史',
  'request.label': '请求 #{request}',
  'request.labelCompaction': '请求 #{request} · 压缩',
  'request.compaction': '压缩 · {section}',
  'request.compactionPurpose': '压缩',
  'request.retryProgress': '{retry}/{maximum}',
  'request.collapsedSummary': '已收起的{kind}概述，{summary}',
  'request.collapsedTurn': '轮次',
  'request.collapsedAssistant': '助手',
  'request.rowAria': '{request}{kind}，{content}',
  'request.rowPrefix': '请求 {request}，',
  'request.rowAriaCompaction': '请求 {request}，压缩',
  'request.noContent': '无内容',
  'summary.toolCalls.one': '{count} 个工具调用',
  'summary.toolCalls.other': '{count} 个工具调用',
  'summary.steps.one': '{count} 个步骤',
  'summary.steps.other': '{count} 个步骤',
  'details.event': '事件详情',
  'details.resize': '调整事件详情宽度',
  'details.resizeTitle': '拖动调整大小；双击恢复默认值。',
  'details.close': '关闭详情',
  'details.status': '状态',
  'details.purpose': '用途',
  'details.provider': '提供方',
  'details.model': '模型',
  'details.toolCalls': '工具调用',
  'details.subtoolCalls': '子工具调用',
  'details.error': '错误',
  'details.failure.auth': 'API 密钥无效',
  'details.retry': '重试',
  'details.scheduled': '已计划',
  'details.retryDelay': '重试延迟',
  'details.result': '结果',
  'details.compacted': '已压缩',
  'details.assistantMessage': '助手消息',
  'details.source': '来源',
  'details.hierarchy': '层级',
  'details.toolCall': '工具调用',
  'timeline.aria': '轨迹时间线',
  'timeline.overviewAria': '时间线概览；水平拖动可聚焦事件',
  'timeline.noTimingData': '无计时数据',
  'timeline.total': '总计 {duration}',
  'timeline.started': '开始于 {time}',
  'timeline.ttftDecoding': '首 token {ttft} · 解码 {decoding}',
  'layout.compacting': '正在压缩上下文…',
  'layout.compactionFailed': '上下文压缩失败',
  'layout.compacted': '上下文已压缩',
  'layout.toolCallOnly': '仅工具调用',
  'layout.imageOnly': '图片 ×{count}',
  'layout.fileAttachments': '文件 ×{count}',
  'layout.initialSystemPrompt': '初始系统提示词',
  'layout.systemPromptUpdated': '系统提示词已更新',
  'layout.toolsUpdated': '工具已更新',
  'layout.systemPromptAndToolsUpdated': '系统提示词和工具已更新',
  'layout.compactionInterrupted': '上下文压缩在完成前被中断。',
};

/**
 * 取一条文案并按 `{name}` 占位符填参。
 * @param {string} key 字典键
 * @param {Record<string, unknown>} [params] 占位符取值
 * @returns {string}
 */
export function tj(key, params) {
  const template = ZH[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    (name in params ? String(params[name]) : whole));
}

// ---------------------------------------------------------------- 记录契约

/** 账本记录种类（与上游 TrajectoryCellKind 一致）。 */
export const KINDS = ['system', 'user', 'context', 'compacted', 'message', 'tool', 'subtool'];

/** 账本里的 kind → 文案键（注意 message 显示成「助手」）。 */
export const KIND_LABEL_KEY = {
  system: 'kind.system',
  user: 'kind.user',
  context: 'kind.context',
  compacted: 'kind.compacted',
  message: 'kind.assistant',
  tool: 'kind.tool',
  subtool: 'kind.subtool',
};

/**
 * 跨历史分页稳定的记录标识（上游 trajectoryRecordId）。
 * @param {object} cell 轨迹记录
 * @returns {string}
 */
export function trajectoryRecordId(cell) {
  if (cell.recordId !== undefined) return cell.recordId;
  if (cell.callId !== undefined) return `${cell.kind} call ${cell.callId}`;
  if (cell.sourceSeq !== undefined) return `${cell.kind} seq ${cell.sourceSeq}`;
  return `${cell.kind} index ${cell.index}`;
}

/** 千分位整数 */
function grouped(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 毫秒 → 「N 毫秒」；未知返回破折号。
 * @param {number|null} milliseconds
 * @returns {string}
 */
export function formatDurationMillis(milliseconds) {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '—';
  return tj('unit.milliseconds', { value: grouped(Math.round(milliseconds)) });
}

/**
 * 秒 → 毫秒文案。
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatElapsedSeconds(seconds) {
  return formatDurationMillis(seconds === null ? null : seconds * 1000);
}

/** 明细面板里的短时长：<1s 用毫秒，否则用秒。 */
export function formatDurationMs(milliseconds) {
  if (milliseconds < 1000) return tj('unit.milliseconds', { value: Math.round(milliseconds) });
  return tj('unit.seconds', {
    value: (milliseconds / 1000).toFixed(milliseconds < 10000 ? 2 : 1),
  });
}

// ---------------------------------------------------------------- Markdown 预览

const PREVIEW_SOURCE_CHARACTERS = 2048;
const PREVIEW_OUTPUT_CHARACTERS = 512;

/**
 * Markdown → 单行纯文本预览（上游 trajectory-preview.ts）。
 * @param {string} text
 * @returns {string}
 */
export function trajectoryPreviewText(text) {
  const source = String(text ?? '').slice(0, PREVIEW_SOURCE_CHARACTERS);
  const compact = markdownPlainText(source).replace(/\s+/g, ' ').trim();
  const preview = compact.slice(0, PREVIEW_OUTPUT_CHARACTERS).trimEnd();
  return source.length < String(text ?? '').length || preview.length < compact.length
    ? `${preview}…`
    : preview;
}

/**
 * 把 Markdown 片段折成纯文本。走同一个 marked 渲染器，保证与「预览」页签一致，
 * 只是把块级元素之间补上换行、再去掉标签。
 * @param {string} source
 * @returns {string}
 */
export function markdownPlainText(source) {
  const holder = document.createElement('div');
  try {
    holder.append(markdownFragment(source));
  } catch {
    return source;
  }
  for (const el of holder.querySelectorAll('br')) el.replaceWith('\n');
  for (const el of holder.querySelectorAll('pre, blockquote, li, p, h1, h2, h3, h4, h5, h6, tr')) {
    el.append(document.createTextNode('\n'));
  }
  return holder.textContent ?? '';
}

// ---------------------------------------------------------------- 事件读取工具

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 事件里的内容块数组。
 * 真实日志里消息体可能是块数组，也可能是一句纯文本（PLUGIN-EXT.md §1 的示例
 * 就是字符串）；字符串一律包成单个 text 块，免得整行只能渲染成空。
 */
function blockList(value) {
  const record = asRecord(value);
  const content = record?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return null;
}

/** 内容块 → 上游 AssistantBlock */
export function toAssistantBlock(block) {
  const record = asRecord(block);
  if (!record) return { kind: 'other', block };
  switch (record.type) {
    case 'text': return { kind: 'text', text: String(record.text ?? '') };
    case 'reasoning': return { kind: 'reasoning', text: String(record.text ?? '') };
    case 'image': return { kind: 'image', attachment: record.attachment };
    case 'tool-call': return {
      kind: 'tool-call',
      callId: String(record.id ?? record.callId ?? ''),
      name: String(record.name ?? ''),
      argsRaw: typeof record.arguments === 'string'
        ? record.arguments
        : JSON.stringify(record.arguments ?? {}),
    };
    default: return { kind: 'other', block };
  }
}

/** 内容块数组 → AssistantBlock[] */
export function toAssistantBlocks(content) {
  return (Array.isArray(content) ? content : []).map(toAssistantBlock);
}

/** 内容块 → 上游 TrajectorySourceBlock */
export function sourceBlock(value) {
  const record = asRecord(value);
  if (!record) return { type: 'unknown', content: stringifySourceValue(value) };
  const type = typeof record.type === 'string' ? record.type : 'unknown';
  if (typeof record.text === 'string') {
    return { type: type === 'reasoning' ? 'thinking' : type, content: record.text };
  }
  if (type === 'image' && asRecord(record.attachment)?.attachmentId) {
    return { type, content: '', attachment: record.attachment };
  }
  return { type, content: stringifySourceValue(value) };
}

function stringifySourceValue(value) {
  const json = JSON.stringify(value, null, 2);
  return json || String(value);
}

/** 失败信息 → 可展示的 {code, message}（上游 displayFailure） */
export function displayFailure(failure) {
  if (failure === null || typeof failure !== 'object') return { message: String(failure) };
  const code = typeof failure.code === 'string' ? failure.code : undefined;
  if (code === 'AUTH') return { code, message: '' };
  return {
    ...(code === undefined ? {} : { code }),
    message: typeof failure.message === 'string'
      ? failure.message
      : JSON.stringify(failure),
  };
}

function usageOf(value) {
  const record = asRecord(value);
  if (!record) return undefined;
  const pick = (a, b) => num(record[a]) ?? num(record[b]) ?? undefined;
  const usage = {
    inputTokens: pick('inputTokens', 'prompt_tokens'),
    outputTokens: pick('outputTokens', 'completion_tokens'),
    cacheReadTokens: num(record.cacheReadTokens) ?? undefined,
    cacheWriteTokens: num(record.cacheWriteTokens) ?? undefined,
    reasoningTokens: num(record.reasoningTokens) ?? undefined,
  };
  return Object.values(usage).some((v) => v !== undefined) ? usage : undefined;
}

// ---------------------------------------------------------------- 快照装配

/**
 * 把原始会话事件折成轨迹视图要的 `TrajectorySnapshot`。
 *
 * 上游这一步由 Cordis 的 ConversationMatch + 各 definition 的状态机完成；
 * 这里在一次顺序扫描里做完同样的归类：消息节点、工具结果、助手请求、
 * 系统提示词变更、压缩请求、轮次结束。
 *
 * @param {Array<{type: string, seq: number, time: number, data: any}>} events 按 seq 升序
 * @param {{running?: boolean, liveText?: string}} [opts]
 * @returns {{eventNodes: Array, eventLocations: Map, requests: Array, callSchemas: Map,
 *            systemPrompts: Array, partial: object|null, runningCalls: Array}}
 */
export function buildTrajectorySnapshot(events, opts = {}) {
  /** @type {Array} 已定型的事件节点（不含助手/工具，它们从请求与结果派生） */
  const nodes = [];
  /** @type {Map<number, object>} seq → 位置（给 steering 用） */
  const eventLocations = new Map();
  /** @type {Array} 助手请求视图 */
  const requests = [];
  /** @type {Array} 系统提示词节点 */
  const systemPrompts = [];

  const compactionEvents = [];
  const callById = new Map();      // callId → 工具调用（running 或已定型）
  const resultByCall = new Map();  // callId → 工具结果节点(RunningToolCall 形状)
  const assistantByStep = new Map(); // "turn\0step" → 助手节点
  const stepByKey = new Map();     // "turn\0step" → {startSeq, startTime, stepEnd}
  const turnEndings = [];
  const callSchemas = new Map();
  const headers = [];
  const runningCalls = [];
  let currentHeader = null;
  let systemText = '';

  const stepKey = (turn, step) => `${turn} ${step}`;

  // 每次遇到 request/header 就累计一个提示词状态；它同时是 assistant 请求的 prompt。
  const promptFromHeader = (data) => {
    const header = asRecord(data.header) ?? asRecord(data);
    const tools = Array.isArray(header?.tools) ? header.tools : [];
    return {
      config: header?.config ?? {},
      system: systemText,
      tools,
    };
  };

  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue;
    const d = asRecord(ev.data) ?? {};
    const seq = Number.isFinite(ev.seq) ? ev.seq : 0;
    const time = Number.isFinite(ev.time) ? ev.time : 0;

    switch (ev.type) {
      case 'user/message': {
        const source = asRecord(d.source) ?? {};
        const kind = typeof source.kind === 'string' ? source.kind : 'user';
        const content = blockList(d.message) ?? blockList(d) ?? [];
        const base = {
          seq,
          time,
          content,
          source: d.source ?? { kind: 'user' },
          // user/message 在协议里不带 turn；带了就记下来，比靠「其后第一个助手」
          // 推断更准（历史窗口从中间开始时尤其明显）
          ...(Number.isFinite(d.turn) ? { turn: d.turn } : {}),
        };
        nodes.push(kind === 'user'
          ? { ...base, kind: 'user' }
          : { ...base, kind: 'context' });
        eventLocations.set(seq, { kind: 'unresolved' });
        break;
      }

      case 'system/message': {
        const content = blockList(d.message) ?? blockList(d) ?? [];
        const text = content
          .filter((b) => asRecord(b)?.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('\n');
        const previous = systemText;
        systemText = text;
        if (text !== previous) {
          systemPrompts.push({
            seq, time,
            turn: Number.isFinite(d.turn) ? d.turn : 0,
            step: Number.isFinite(d.step) ? d.step : 0,
            text,
            update: previous !== '',
            previousText: previous,
          });
        }
        break;
      }

      case 'request/header': {
        const prompt = promptFromHeader(d);
        currentHeader = { seq, time, prompt, reason: d.reason ?? null };
        headers.push(currentHeader);
        break;
      }

      case 'step/start': {
        const turn = Number.isFinite(d.turn) ? d.turn : 0;
        const step = Number.isFinite(d.step) ? d.step : 0;
        stepByKey.set(stepKey(turn, step), {
          startSeq: seq, startTime: time, requested: true,
          header: currentHeader, headerSeq: currentHeader?.seq ?? null,
        });
        break;
      }

      case 'step/end': {
        const key = stepKey(Number.isFinite(d.turn) ? d.turn : 0, Number.isFinite(d.step) ? d.step : 0);
        const entry = stepByKey.get(key);
        if (entry) entry.stepEnd = { seq, time };
        break;
      }

      case 'assistant/live-chunk':
        // 流式增量只用于 partial；这里不落节点（快照只保留已定型的内容）
        break;

      case 'assistant/message': {
        const turn = Number.isFinite(d.turn) ? d.turn : 0;
        const step = Number.isFinite(d.step) ? d.step : 0;
        const key = stepKey(turn, step);
        const entry = stepByKey.get(key) ?? { startTime: null };
        const message = asRecord(d.message) ?? {};
        const source = asRecord(message.source) ?? {};
        const blocks = toAssistantBlocks(blockList(message) ?? []);
        const node = {
          kind: 'assistant',
          seq,
          messageId: message.id,
          time,
          turn,
          step,
          blocks,
          usage: usageOf(d.usage),
          provenance: (source.provider || source.model)
            ? { provider: String(source.provider ?? ''), model: String(source.model ?? '') }
            : undefined,
          timing: {
            stepStartTime: entry.startTime ?? null,
            firstTokenTime: null,
            completedTime: time,
          },
          ...(d.interrupted === true ? { interrupted: true } : {}),
        };
        assistantByStep.set(key, node);
        nodes.push(node);
        break;
      }

      case 'tool/call': {
        const callId = String(d.callId ?? d.id ?? '');
        if (!callId) break;
        callById.set(callId, {
          callId,
          name: String(d.name ?? 'tool'),
          argsRaw: typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? {}),
          description: typeof d.description === 'string' ? d.description : undefined,
          turn: Number.isFinite(d.turn) ? d.turn : 0,
          step: Number.isFinite(d.step) ? d.step : 0,
          time,
          subCalls: [],
        });
        break;
      }

      case 'tool/result': {
        const message = asRecord(d.message) ?? {};
        const source = asRecord(message.source) ?? {};
        const callId = String(source.callId ?? d.callId ?? '');
        if (!callId) break;
        const call = callById.get(callId);
        const resultBlock = (blockList(message) ?? [])[0];
        const blockRecord = asRecord(resultBlock);
        const content = blockList(blockRecord) ?? blockList(resultBlock) ?? [];
        const error = asRecord(d.error);
        const resultNode = {
          kind: 'tool-result',
          seq,
          time,
          callId,
          call: call ? { name: call.name, argsRaw: call.argsRaw } : null,
          callTime: call?.time ?? null,
          content,
          isError: blockRecord?.isError === true || error !== null,
          error: error ? { name: String(error.name ?? 'Error'), code: String(error.code ?? 'error') } : undefined,
          meta: d.meta,
          subCalls: [],
        };
        resultByCall.set(callId, resultNode);
        nodes.push(resultNode);
        break;
      }

      case 'tool/ptc-dispatch-start':
      case 'tool/ptc-dispatch': {
        const parentCallId = String(d.parentCallId ?? '');
        const subCallId = String(d.subCallId ?? '');
        const parent = callById.get(parentCallId);
        if (!parent || !subCallId) break;
        const settled = ev.type === 'tool/ptc-dispatch';
        const existing = parent.subCalls.find((c) => c.callId === subCallId);
        const sub = settled
          ? {
            kind: 'tool-result',
            seq,
            time,
            callId: subCallId,
            parentCallId,
            call: { name: String(d.name ?? existing?.name ?? 'code'), argsRaw: JSON.stringify(d.arguments ?? {}) },
            callTime: existing?.time ?? null,
            content: blockList(d) ?? [],
            isError: d.isError === true,
            subCalls: [],
          }
          : {
            callId: subCallId,
            parentCallId,
            name: String(d.name ?? 'code'),
            argsRaw: JSON.stringify(d.arguments ?? {}),
            turn: parent.turn,
            step: parent.step,
            time,
            subCalls: [],
          };
        if (existing) parent.subCalls[parent.subCalls.indexOf(existing)] = sub;
        else parent.subCalls.push(sub);
        break;
      }

      case 'turn/end': {
        const reason = parseTurnReason(d.reason);
        const failure = reason.kind === 'error' ? displayFailure(reason.raw?.error ?? reason) : undefined;
        turnEndings.push({
          turn: Number.isFinite(d.turn) ? d.turn : 0,
          time,
          ...(failure === undefined ? {} : { error: failure.message, errorCode: failure.code }),
        });
        break;
      }

      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/end':
        compactionEvents.push({ type: ev.type, seq, time, data: d });
        break;

      default:
        break; // 未知类型忽略，绝不断流（协议 §8.6）
    }
  }

  // ---- 助手请求：每个 step 一个，按 step/start 的顺序编号
  for (const [key, entry] of stepByKey) {
    const [turnText, stepText] = key.split(' ');
    const turn = Number(turnText);
    const step = Number(stepText);
    const node = assistantByStep.get(key);
    const boundary = entry.stepEnd;
    if (!entry.requested && node === undefined && boundary === undefined) continue;
    const status = node !== undefined && node.interrupted !== true
      ? 'complete'
      : boundary !== undefined ? 'error' : 'running';
    requests.push({
      purpose: 'assistant',
      startSeq: entry.startSeq ?? node?.seq ?? 0,
      turn,
      step,
      startedAt: entry.startTime ?? null,
      completedAt: node?.time ?? boundary?.time ?? null,
      status,
      prompt: entry.header?.prompt,
      headerSeq: entry.headerSeq ?? null,
      ...(node === undefined ? {} : {
        resultSeq: node.seq,
        provenance: node.provenance,
      }),
      ...(node?.usage === undefined ? {} : { usage: node.usage }),
    });
  }

  // ---- 压缩请求：插件实现 compaction/* 才会有，没有就一行为空
  const compactionById = new Map();
  for (const ev of compactionEvents) {
    const id = String(ev.data.compactionId ?? `seq-${ev.seq}`);
    const state = compactionById.get(id) ?? {};
    if (ev.type === 'compaction/start') state.start = ev;
    else if (ev.type === 'compaction/summary') state.summary = ev;
    else state.end = ev;
    compactionById.set(id, state);
  }
  for (const state of compactionById.values()) {
    if (!state.start) continue;
    const { start, summary, end } = state;
    requests.push({
      purpose: 'compaction',
      startSeq: start.seq,
      turn: Number.isFinite(start.data.turn) ? start.data.turn : null,
      step: 0,
      startedAt: start.time,
      completedAt: end ? end.time : null,
      status: !end ? 'running' : (end.data.error === undefined ? 'complete' : 'error'),
      ...(end && end.data.error !== undefined ? { error: String(end.data.error) } : {}),
      ...(summary === undefined ? {} : {
        resultSeq: summary.seq,
        summary: blockList(summary.data) ?? [],
        ...(summary.data.rawOutput === undefined
          ? {}
          : { rawOutput: blockList(summary.data.rawOutput) ?? [] }),
        provenance: { provider: summary.data.provider, model: summary.data.model },
        requestConfig: {
          provider: summary.data.provider,
          model: summary.data.model,
          purpose: 'compaction',
        },
        ...(usageOf(summary.data.usage) === undefined ? {} : { usage: usageOf(summary.data.usage) }),
      }),
    });
  }

  // ---- 系统提示词变更：由 request/header 的差异产生，带上完整 config 与工具目录
  const promptChanges = promptChangesFromHeaders(headers, systemPrompts);
  for (const change of promptChanges) {
    const request = requests.find((r) => r.purpose === 'assistant' && r.headerSeq === change.seq);
    // promptChange 记在请求上，layout 会按 change.seq 在图里补一行「系统提示词已更新」，
    // 同时把这次请求的 prompt（config + 工具目录）当作该行的详情。
    if (request) request.promptChange = change;
  }

  // ---- 工具 schema：把请求当时的工具目录挂到调用上
  for (const header of headers) {
    for (const tool of header.prompt.tools) {
      if (tool && typeof tool.name === 'string') callSchemas.set(`@${tool.name}`, tool);
    }
  }
  for (const call of callById.values()) {
    const settled = resultByCall.get(call.callId);
    if (!settled) runningCalls.push(call);
  }

  return {
    eventNodes: nodes,
    eventLocations,
    requests: requests.sort((a, b) => a.startSeq - b.startSeq),
    callSchemas,
    // 有 request/header 时系统提示词行由它产生（带 config 与工具目录），
    // 否则退回 system/message 本身。
    systemPrompts: headers.length > 0 ? [] : systemPrompts,
    partial: null,
    runningCalls,
  };
}

/**
 * 把一串 request/header 折成「提示词变更」。
 * 第一条是 initial；之后按 system / tools 哪一项变了给 kind，并带上上一份快照。
 */
function promptChangesFromHeaders(headers, systemPrompts) {
  const changes = [];
  let previous = null;
  for (const [index, header] of headers.entries()) {
    const prompt = header.prompt;
    if (index === 0) {
      changes.push({
        seq: header.seq, time: header.time, kind: 'initial',
        requestStartSeq: header.seq,
        prompt,
      });
    } else {
      const systemChanged = previous.system !== prompt.system;
      const toolsChanged = JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools);
      if (systemChanged || toolsChanged) {
        changes.push({
          seq: header.seq,
          time: header.time,
          kind: systemChanged && toolsChanged ? 'system-and-tools' : systemChanged ? 'system' : 'tools',
          previous,
          requestStartSeq: header.seq,
          prompt,
        });
      }
    }
    previous = prompt;
  }
  // 日志里没有 request/header 时退回 system/message 本身
  if (changes.length === 0) {
    for (const prompt of systemPrompts) {
      changes.push({
        seq: prompt.seq,
        time: prompt.time,
        kind: prompt.update ? 'system' : 'initial',
        requestStartSeq: -1,
        systemPromptOnly: { seq: prompt.seq, time: prompt.time, text: prompt.text },
      });
    }
  }
  return changes;
}

/**
 * 归一化 `turn/end` 的 reason。
 * 与 model.js 的 parseTurnReason 保持一致（那边是转录用的，这里再放一份是为了
 * 让轨迹数据层不依赖转录层）。
 */
function parseTurnReason(reason) {
  if (reason == null || reason === '') return { kind: 'completed', message: '', code: null, raw: null };
  if (typeof reason === 'string') return { kind: reason, message: '', code: null, raw: null };
  if (typeof reason !== 'object') return { kind: 'completed', message: '', code: null, raw: null };
  const kind = typeof reason.kind === 'string' && reason.kind
    ? reason.kind
    : (typeof reason.code === 'string' && reason.code ? reason.code : 'unknown');
  const failure = asRecord(reason.error) ?? reason;
  return {
    kind,
    message: typeof failure.message === 'string' ? failure.message : '',
    code: typeof failure.code === 'string' ? failure.code : null,
    raw: reason,
  };
}

// ---------------------------------------------------------------- 助手消息补充

/**
 * 给快照补上流式中的助手消息（partial）与运行中的工具调用。
 * 上游由 assistant/live-chunk 事件驱动；控制台用的是中转服务器缓存下来的
 * 流式文本，形状对不上，所以在这里单独合成。
 * @param {object} snapshot buildTrajectorySnapshot 的返回值（会被就地修改）
 * @param {{text?: string, revision?: number}|null} live 中转服务器缓存的流式文本
 * @returns {object} 同一个快照
 */
export function attachLivePartial(snapshot, live) {
  if (!live?.text) return snapshot;
  const last = snapshot.requests.filter((r) => r.purpose === 'assistant').at(-1);
  if (!last || last.status === 'complete') return snapshot;
  snapshot.partial = {
    turn: last.turn,
    step: last.step,
    blocks: [{ kind: 'text', text: live.text }],
  };
  return snapshot;
}

// ---------------------------------------------------------------- layout

/** 一轮里可以折进「过程」的节点（与转录层一致） */
function finiteTime(time) {
  return typeof time === 'number' && Number.isFinite(time) ? time : null;
}

function durationSeconds(later, earlier) {
  if (earlier === null || !Number.isFinite(later) || !Number.isFinite(earlier)) return null;
  return Math.max(0, (later - earlier) / 1000);
}

function useUsage(cell, usage) {
  if (usage === undefined) return;
  if (usage.inputTokens !== undefined) cell.input = usage.inputTokens;
  if (usage.cacheReadTokens !== undefined) cell.cacheRead = usage.cacheReadTokens;
  if (usage.cacheWriteTokens !== undefined) cell.cacheWrite = usage.cacheWriteTokens;
  if (usage.outputTokens !== undefined) cell.output = usage.outputTokens;
  if (usage.reasoningTokens !== undefined) cell.think = usage.reasoningTokens;
}

function imageBlockCount(content) {
  return content.filter((block) => block?.type === 'image').length;
}

function fileBlockCount(content) {
  return content.filter((block) => block?.type === 'file').length;
}

function previewContent(content) {
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return undefined;
}

function detailContent(content) {
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n');
}

function detailReasoning(content) {
  return content
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n');
}

function summarizeCall(name, argsRaw) {
  return {
    text: name,
    ...(argsRaw === '' ? {} : { previewMarkdown: argsRaw }),
  };
}

function resultAsText(result) {
  return {
    text: result?.result ?? '',
    ...(result?.resultPreviewMarkdown === undefined
      ? {}
      : { previewMarkdown: result.resultPreviewMarkdown }),
  };
}

function summarizeResult(node) {
  if (node.isError) return { result: node.error?.code ?? 'error' };
  for (const block of node.content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      return { result: '', resultPreviewMarkdown: block.text };
    }
  }
  const images = imageBlockCount(node.content);
  if (images > 0) return { result: tj('layout.imageOnly', { count: images }) };
  return { result: tj('record.noOutput') };
}

function detailResult(node) {
  if (node.isError) {
    return node.error === undefined ? 'error' : `${node.error.name}: ${node.error.code}`;
  }
  const text = node.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  if (text !== '') return text;
  const images = imageBlockCount(node.content);
  if (images > 0) return tj('layout.imageOnly', { count: images });
  if (node.content.length === 0
    || node.content.every((b) => b?.type === 'text' && !String(b.text ?? ''))) {
    return tj('record.noOutput');
  }
  return JSON.stringify(node.content, null, 2);
}

function inputCellDetail(node) {
  const preview = previewContent(node.content);
  const previewMarkdown = preview === '' ? undefined : preview;
  const images = imageBlockCount(node.content);
  const files = fileBlockCount(node.content);
  const attachmentSummary = [
    previewMarkdown === undefined && images > 0 ? tj('layout.imageOnly', { count: images }) : undefined,
    files > 0 ? tj('layout.fileAttachments', { count: files }) : undefined,
  ].filter((v) => v !== undefined).join(' · ');
  return {
    text: attachmentSummary,
    ...(previewMarkdown === undefined ? {} : { previewMarkdown }),
    sourceSeq: node.seq,
    messageSource: node.source,
    inputDetail: detailContent(node.content),
    sourceBlocks: node.content.map(sourceBlock),
    timeSeconds: 0,
    startedAt: finiteTime(node.time),
  };
}

function summarizeAssistantActivity(blocks) {
  const tools = new Set();
  for (const block of blocks) {
    if (block.kind === 'tool-call') tools.add(block.name);
  }
  if (tools.size > 0) return tj('layout.toolCallOnly');
  const images = blocks.filter((b) => b.kind === 'image').length;
  if (images > 0) return tj('layout.imageOnly', { count: images });
  return '';
}

function promptChangeLabel(change) {
  if (change.kind === 'initial') return tj('layout.initialSystemPrompt');
  if (change.kind === 'system') return tj('layout.systemPromptUpdated');
  if (change.kind === 'tools') return tj('layout.toolsUpdated');
  return tj('layout.systemPromptAndToolsUpdated');
}

function assistantSourceBlock(block) {
  switch (block.kind) {
    case 'text': return { type: 'text', content: block.text };
    case 'reasoning': return { type: 'thinking', content: block.text };
    case 'tool-call': return {
      type: 'tool-call', content: block.argsRaw, callId: block.callId, toolName: block.name,
    };
    case 'image': return { type: 'image', content: '', attachment: block.attachment };
    default: return sourceBlock(block.block);
  }
}

/** 展开一个助手消息 → 消息行 + 它发起的每个工具行 */
function expandAssistant(node, startIndex, prevAbsTime, results, callStarts, calls, opts = {}) {
  const streaming = opts.streaming === true;
  if (streaming && node.blocks.length === 0) return [];
  const out = [];
  let index = startIndex - 1;
  const usage = node.usage;
  const recordedStart = finiteTime(node.timing?.stepStartTime);
  const messageDuration = streaming ? null : durationSeconds(node.time, recordedStart ?? prevAbsTime);
  const nodeAbs = streaming ? null : finiteTime(node.time);

  const messageText = node.blocks
    .filter((b) => b.kind === 'text' && (!streaming || b.text !== ''))
    .map((b) => b.text).join('\n\n');
  const thinkingText = node.blocks
    .filter((b) => b.kind === 'reasoning' && (!streaming || b.text !== ''))
    .map((b) => b.text).join('\n\n');

  const message = {
    index: ++index,
    recordId: `assistant ${node.turn} ${node.step}`,
    kind: 'message',
    sourceSeq: node.seq,
    text: messageText !== '' || thinkingText !== '' ? '' : summarizeAssistantActivity(node.blocks),
    ...(messageText !== ''
      ? { previewMarkdown: messageText }
      : thinkingText !== '' ? { previewMarkdown: thinkingText } : {}),
    ...(messageText !== '' ? { outputDetail: messageText } : {}),
    ...(thinkingText !== '' ? { thinkingDetail: thinkingText } : {}),
    sourceBlocks: node.blocks.map(assistantSourceBlock),
    timeSeconds: messageDuration,
    startedAt: recordedStart,
  };
  useUsage(message, usage);
  message.assistantMetrics = {
    timingRecorded: node.timing !== undefined,
    stepStartTime: node.timing?.stepStartTime ?? null,
    firstTokenTime: node.timing?.firstTokenTime ?? null,
    completedTime: streaming ? null : finiteTime(node.time),
    usageProvided: usage !== undefined,
    outputTokens: Number.isFinite(usage?.outputTokens) ? usage.outputTokens : null,
  };
  out.push({ absTime: nodeAbs, cell: message });

  for (const block of node.blocks) {
    if (block.kind !== 'tool-call') continue;
    const result = results.get(block.callId);
    const toolDuration = streaming || result === undefined
      ? null
      : durationSeconds(result.time, result.callTime);
    const callAbs = finiteTime(callStarts.get(block.callId));
    const call = calls.get(block.callId);
    const resultPreview = result === undefined ? undefined : summarizeResult(result);
    out.push({
      absTime: callAbs,
      toolName: block.name,
      callId: block.callId,
      ...(call === undefined ? {} : { subCalls: call.subCalls }),
      cell: {
        index: ++index,
        kind: 'tool',
        ...summarizeCall(block.name, block.argsRaw),
        inputDetail: block.argsRaw,
        callId: block.callId,
        ...(result !== undefined
          ? {
            outputDetail: detailResult(result),
            outputBlocks: result.content.map(sourceBlock),
            ...resultPreview,
            isError: result.isError,
          }
          : {}),
        timeSeconds: toolDuration,
        startedAt: callAbs,
      },
    });
  }
  return out;
}

/** 子调用（run_code 的 PTC 派发） */
function expandSubCalls(subs, startIndex) {
  if (!subs || subs.length === 0) return [];
  const out = [];
  let index = startIndex;
  for (const sub of subs) {
    const settled = 'kind' in sub;
    const resultPreview = settled ? summarizeResult(sub) : undefined;
    const laid = {
      absTime: settled ? finiteTime(sub.callTime ?? sub.time) : finiteTime(sub.time),
      toolName: settled ? (sub.call?.name ?? sub.callId) : sub.name,
      callId: sub.callId,
      cell: {
        index: ++index,
        kind: 'subtool',
        callId: sub.callId,
        ...(settled
          ? (sub.call !== null
            ? summarizeCall(sub.call.name, sub.call.argsRaw)
            : resultAsText(resultPreview))
          : summarizeCall(sub.name, sub.argsRaw)),
        ...(settled
          ? (sub.call !== null ? { inputDetail: sub.call.argsRaw } : {})
          : { inputDetail: sub.argsRaw }),
        ...(settled
          ? {
            outputDetail: detailResult(sub),
            outputBlocks: sub.content.map(sourceBlock),
            ...resultPreview,
            isError: sub.isError,
          }
          : {}),
        timeSeconds: settled ? durationSeconds(sub.time, sub.callTime) : null,
        startedAt: settled ? finiteTime(sub.callTime) : finiteTime(sub.time),
      },
    };
    out.push(laid);
    for (const child of expandSubCalls(sub.subCalls, index)) {
      out.push(child);
      index = child.cell.index;
    }
  }
  return out;
}

function withSubCalls(laidList) {
  if (!laidList.some((laid) => laid.subCalls !== undefined && laid.subCalls.length > 0)) {
    return laidList;
  }
  const out = [];
  let index = laidList[0] !== undefined ? laidList[0].cell.index - 1 : 0;
  for (const laid of laidList) {
    out.push({ ...laid, cell: { ...laid.cell, index: ++index } });
    for (const sub of expandSubCalls(laid.subCalls, index)) {
      out.push(sub);
      index = sub.cell.index;
    }
  }
  return out;
}

function indexFollowingAssistants(nodes) {
  const following = new Array(nodes.length);
  let assistant;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    following[i] = assistant;
    if (nodes[i]?.kind === 'assistant') assistant = nodes[i];
  }
  return following;
}

function enclosingUserTurn(followingAssistant, partial, lastAssistantTurn) {
  if (followingAssistant !== undefined) return followingAssistant.turn;
  if (partial !== null) return partial.turn;
  if (lastAssistantTurn !== null) return lastAssistantTurn + 1;
  return 1;
}

function steeringPlacement(followingAssistant, partial, lastAssistantTurn, location) {
  if (location?.kind === 'step') return { turn: location.turn.turn, step: location.step.step };
  const locatedTurn = location?.kind === 'turn' ? location.turn.turn : undefined;
  if (followingAssistant !== undefined
    && (locatedTurn === undefined || followingAssistant.turn === locatedTurn)) {
    return {
      turn: followingAssistant.turn,
      ...(followingAssistant.step > 0 ? { step: followingAssistant.step } : {}),
    };
  }
  if (partial !== null && (locatedTurn === undefined || partial.turn === locatedTurn)) {
    return { turn: partial.turn, ...(partial.step > 0 ? { step: partial.step } : {}) };
  }
  if (locatedTurn !== undefined) return { turn: locatedTurn };
  return { turn: lastAssistantTurn ?? 1 };
}

function enclosingPromptTurn(nodes, seq, partial) {
  const next = nodes.find((n) => n.seq > seq && n.kind === 'assistant' && n.step > 0);
  if (next) return next.turn;
  return partial?.turn ?? 1;
}

function firstVisibleTurn(nodes, partial) {
  const turns = nodes.flatMap((n) => (n.kind === 'assistant' && n.turn > 0 ? [n.turn] : []));
  if (partial !== null && partial.turn > 0) turns.push(partial.turn);
  return turns.length === 0 ? 1 : Math.min(...turns);
}

function firstCellIndex(turn) {
  return Math.min(
    ...turn.groups.flatMap((group) => group.cells.map((cell) => cell.index)),
    Number.POSITIVE_INFINITY,
  );
}

function groupDescription(laid) {
  const parts = [];
  const times = [];
  for (const l of laid) {
    if (l.absTime === null || !Number.isFinite(l.absTime)) continue;
    times.push(l.absTime);
    if (l.cell.kind === 'tool' && l.cell.timeSeconds !== null && Number.isFinite(l.cell.timeSeconds)) {
      times.push(l.absTime + l.cell.timeSeconds * 1000);
    }
  }
  if (times.length >= 2) {
    const span = formatElapsedSeconds((Math.max(...times) - Math.min(...times)) / 1000);
    if (span !== undefined) parts.push(span);
  } else if (times.length === 1) {
    const own = laid.find((l) => l.absTime === times[0])?.cell.timeSeconds;
    if (own !== null && own !== undefined) parts.push(formatElapsedSeconds(own));
  }
  const tools = new Map();
  for (const l of laid) {
    if (l.toolName === undefined || l.cell.kind !== 'tool') continue;
    tools.set(l.toolName, (tools.get(l.toolName) ?? 0) + 1);
  }
  for (const [name, count] of tools) parts.push(count > 1 ? `${name}×${count}` : name);
  return parts.length === 0 ? undefined : parts.join(' ');
}

/**
 * 把快照折成 `TrajectoryTurnModel[]`（turn → 消息/步骤 分组 → cell）。
 * 逐条对应上游 `deriveTrajectoryLayout`。
 * @param {object} input buildTrajectorySnapshot 的结果
 * @returns {Array<{turn: number|null, groups: Array<{title: string, description?: string, cells: Array}>}>}
 */
export function deriveTrajectoryLayout(input) {
  const {
    eventNodes: nodes = [], partial = null, runningCalls = [],
    requests = [], systemPrompts = [],
  } = input;
  const resultByCall = new Map();
  for (const node of nodes) {
    if (node.kind === 'tool-result') resultByCall.set(node.callId, node);
  }
  const callById = new Map(resultByCall);
  for (const call of runningCalls) callById.set(call.callId, call);
  const emittedCallIds = new Set();
  for (const node of nodes) {
    if (node.kind === 'assistant') {
      for (const block of node.blocks) {
        if (block.kind === 'tool-call') emittedCallIds.add(block.callId);
      }
    }
  }
  const followingAssistants = indexFollowingAssistants(nodes);
  const callStartById = new Map();
  for (const result of resultByCall.values()) {
    const startedAt = finiteTime(result.callTime);
    if (startedAt !== null) callStartById.set(result.callId, startedAt);
  }
  for (const call of runningCalls) {
    const startedAt = finiteTime(call.time);
    if (startedAt !== null) callStartById.set(call.callId, startedAt);
  }

  const turns = new Map();
  const standaloneCompactions = [];
  const representedRequests = new Set();
  for (const node of nodes) {
    if (node.kind === 'assistant' && node.step > 0) {
      representedRequests.add(`${node.turn} ${node.step}`);
    }
  }
  if (partial !== null && partial.step > 0) {
    representedRequests.add(`${partial.turn} ${partial.step}`);
  }
  for (const call of runningCalls) {
    if (call.step > 0) representedRequests.add(`${call.turn} ${call.step}`);
  }

  let index = 0;
  let prevAbsTime = null;
  let lastAssistantTurn = null;
  const bucket = (turn) => {
    if (!turns.has(turn)) turns.set(turn, { groups: [] });
    return turns.get(turn);
  };
  const pushMessage = (turn, laid) => {
    const groups = bucket(turn).groups;
    const last = groups.at(-1);
    if (last?.title === tj('group.message')) {
      last.laid.push(laid);
      return;
    }
    groups.push({ title: tj('group.message'), laid: [laid] });
  };
  const pushStep = (turn, step, laid) => {
    if (laid.length === 0) return;
    const groups = bucket(turn).groups;
    const title = tj('group.step', { step });
    const existing = groups.find((group) => group.title === title);
    if (existing !== undefined) {
      existing.laid.push(...laid);
      return;
    }
    groups.push({ title, laid: [...laid] });
  };
  const pushStepInput = (turn, step, laid) => {
    if (laid.length === 0) return;
    const groups = bucket(turn).groups;
    const title = tj('group.step', { step });
    const existing = groups.find((group) => group.title === title);
    if (existing === undefined) {
      groups.push({ title, laid: [...laid] });
      return;
    }
    const at = existing.laid.findIndex((entry) => entry.cell.requestOnly === true);
    if (at === -1) existing.laid.push(...laid);
    else existing.laid.splice(at, 0, ...laid);
  };

  // 排序键：initial 的系统提示词永远排最前
  const entries = [
    ...systemPrompts.map((prompt) => ({
      kind: 'system',
      seq: prompt.seq,
      systemPrompt: prompt.text,
      change: {
        seq: prompt.seq,
        time: prompt.time,
        kind: prompt.update ? 'system' : 'initial',
        ...(prompt.previousText ? { previousText: prompt.previousText } : {}),
      },
    })),
    ...nodes.map((node, nodeIndex) => ({ kind: 'node', seq: node.seq, node, nodeIndex })),
    ...requests
      .filter((r) => r.purpose === 'compaction')
      .map((r) => ({ kind: 'compaction', seq: r.startSeq, request: r })),
    ...requests.flatMap((request) => (
      request.purpose !== 'assistant' || request.promptChange === undefined
        ? []
        : [{
          kind: 'system',
          seq: request.promptChange.seq,
          request,
          change: request.promptChange,
        }])),
    ...requests
      .filter((r) => r.purpose === 'assistant')
      .filter((r) => !representedRequests.has(`${r.turn} ${r.step}`))
      .map((r) => ({ kind: 'request', seq: r.startSeq, request: r })),
  ].sort((left, right) => layoutEntryOrder(left) - layoutEntryOrder(right));

  for (const entry of entries) {
    if (entry.kind === 'request') {
      const { request } = entry;
      pushStep(request.turn, request.step, [{
        absTime: finiteTime(request.startedAt),
        cell: {
          index: ++index,
          kind: 'message',
          text: '',
          sourceSeq: request.startSeq,
          requestOnly: true,
          timeSeconds: request.completedAt === null
            ? null
            : durationSeconds(request.completedAt, request.startedAt),
          startedAt: finiteTime(request.startedAt),
          ...(request.status === 'error' ? { isError: true } : {}),
        },
      }]);
      prevAbsTime = finiteTime(request.completedAt) ?? finiteTime(request.startedAt) ?? prevAbsTime;
      continue;
    }
    if (entry.kind === 'system') {
      const { change, request } = entry;
      const turn = change.kind === 'initial'
        ? firstVisibleTurn(nodes, partial)
        : enclosingPromptTurn(nodes, change.seq, partial);
      pushMessage(turn, {
        absTime: finiteTime(change.time),
        cell: {
          index: ++index,
          kind: 'system',
          text: promptChangeLabel(change),
          sourceSeq: change.seq,
          ...(request?.prompt === undefined ? {} : { promptDetail: request.prompt }),
          ...(entry.systemPrompt === undefined ? {} : { systemPromptDetail: entry.systemPrompt }),
          ...(change.previous === undefined ? {} : { previousPromptDetail: change.previous }),
          timeSeconds: 0,
          startedAt: finiteTime(change.time),
        },
      });
      prevAbsTime = finiteTime(change.time) ?? prevAbsTime;
      continue;
    }
    if (entry.kind === 'compaction') {
      const request = entry.request;
      const rawOutput = request.rawOutput ?? request.summary;
      const thinkingDetail = rawOutput === undefined ? '' : detailReasoning(rawOutput);
      const cell = {
        index: ++index,
        kind: 'compacted',
        text: request.status === 'running'
          ? tj('layout.compacting')
          : request.status === 'error'
            ? (request.error ?? tj('layout.compactionFailed'))
            : request.summary === undefined
              ? tj('layout.compacted')
              : '',
        ...(request.status === 'complete' && request.summary !== undefined
          ? (() => {
            const preview = previewContent(request.summary);
            return preview === undefined ? {} : { previewMarkdown: preview };
          })()
          : {}),
        sourceSeq: request.startSeq,
        ...(request.summary === undefined
          ? {}
          : {
            outputDetail: detailContent(request.summary),
            outputBlocks: request.summary.map(sourceBlock),
          }),
        ...(thinkingDetail === '' ? {} : { thinkingDetail }),
        ...(rawOutput === undefined ? {} : { sourceBlocks: rawOutput.map(sourceBlock) }),
        ...(request.status === 'error' ? { isError: true } : {}),
        timeSeconds: request.completedAt === null
          ? null
          : durationSeconds(request.completedAt, request.startedAt),
        startedAt: finiteTime(request.startedAt),
      };
      useUsage(cell, request.usage);
      const compaction = {
        groups: [{
          title: tj('group.compaction', { seq: request.startSeq }),
          laid: [{ absTime: finiteTime(request.startedAt), cell }],
        }],
      };
      if (request.turn === null) standaloneCompactions.push(compaction);
      else bucket(request.turn).groups.push(...compaction.groups);
      prevAbsTime = finiteTime(request.completedAt) ?? finiteTime(request.startedAt) ?? prevAbsTime;
      continue;
    }

    const { node, nodeIndex: i } = entry;
    if (node.kind === 'user') {
      // 事件自带 turn 就信它；没有才按「其后第一个助手」推断
      const turn = Number.isFinite(node.turn)
        ? node.turn
        : enclosingUserTurn(followingAssistants[i], partial, lastAssistantTurn);
      pushMessage(turn, {
        absTime: finiteTime(node.time),
        cell: { index: ++index, kind: 'user', ...inputCellDetail(node), opensTurn: true },
      });
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
      continue;
    }
    if (node.kind === 'steering') {
      const placement = steeringPlacement(
        followingAssistants[i], partial, lastAssistantTurn, input.eventLocations?.get(node.seq),
      );
      const laid = {
        absTime: finiteTime(node.time),
        cell: { index: ++index, kind: 'user', ...inputCellDetail(node) },
      };
      if (placement.step === undefined) pushMessage(placement.turn, laid);
      else pushStepInput(placement.turn, placement.step, [laid]);
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
      continue;
    }
    if (node.kind === 'assistant') {
      const laidList = withSubCalls(expandAssistant(
        node, index + 1, prevAbsTime, resultByCall, callStartById, callById,
      ));
      if (node.step > 0) pushStep(node.turn, node.step, laidList);
      else for (const laid of laidList) pushMessage(node.turn, laid);
      const last = laidList[laidList.length - 1];
      if (last !== undefined) index = last.cell.index;
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
      lastAssistantTurn = node.turn;
      continue;
    }
    if (node.kind === 'context') {
      const turn = Number.isFinite(node.turn)
        ? node.turn
        : enclosingUserTurn(followingAssistants[i], partial, lastAssistantTurn);
      pushMessage(turn, {
        absTime: finiteTime(node.time),
        cell: { index: ++index, kind: 'context', ...inputCellDetail(node) },
      });
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
      continue;
    }
    if (node.kind === 'compaction') {
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
      continue;
    }
    if (node.kind === 'tool-result') {
      if (!emittedCallIds.has(node.callId)) {
        const toolName = node.call?.name;
        const resultPreview = summarizeResult(node);
        const laidList = [{
          absTime: finiteTime(node.callTime ?? node.time),
          ...(toolName === undefined ? {} : { toolName }),
          callId: node.callId,
          subCalls: node.subCalls,
          cell: {
            index: ++index,
            kind: 'tool',
            sourceSeq: node.seq,
            ...(node.call !== null
              ? summarizeCall(node.call.name, node.call.argsRaw)
              : resultAsText(resultPreview)),
            ...(node.call !== null ? { inputDetail: node.call.argsRaw } : {}),
            outputDetail: detailResult(node),
            outputBlocks: node.content.map(sourceBlock),
            ...resultPreview,
            callId: node.callId,
            isError: node.isError,
            timeSeconds: durationSeconds(node.time, node.callTime),
            startedAt: finiteTime(node.callTime),
          },
        }];
        for (const laid of expandSubCalls(node.subCalls, index)) {
          laidList.push(laid);
          index = laid.cell.index;
        }
        pushStep(0, 1, laidList);
      }
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
    }
  }

  if (partial !== null) {
    const fake = {
      kind: 'assistant', seq: Number.MAX_SAFE_INTEGER, time: 0,
      turn: partial.turn, step: partial.step, blocks: partial.blocks,
    };
    const laidList = withSubCalls(expandAssistant(
      fake, index + 1, prevAbsTime, resultByCall, callStartById, callById, { streaming: true },
    ));
    if (partial.step > 0) pushStep(partial.turn, partial.step, laidList);
    else for (const laid of laidList) pushMessage(partial.turn, laid);
    const last = laidList[laidList.length - 1];
    if (last !== undefined) index = last.cell.index;
  }

  const seenCalls = new Set();
  for (const entry of turns.values()) {
    for (const group of entry.groups) {
      for (const laid of group.laid) {
        if (laid.callId !== undefined) seenCalls.add(laid.callId);
      }
    }
  }
  for (const call of runningCalls) {
    if (seenCalls.has(call.callId)) continue;
    const laidList = [{
      absTime: null,
      toolName: call.name,
      callId: call.callId,
      subCalls: call.subCalls,
      cell: {
        index: ++index,
        kind: 'tool',
        ...summarizeCall(call.name, call.argsRaw),
        inputDetail: call.argsRaw,
        callId: call.callId,
        timeSeconds: null,
        startedAt: finiteTime(call.time),
      },
    }];
    for (const laid of expandSubCalls(call.subCalls, index)) {
      laidList.push(laid);
      index = laid.cell.index;
    }
    if (call.step > 0) pushStep(call.turn, call.step, laidList);
    else for (const laid of laidList) pushMessage(call.turn, laid);
  }

  // 轮次 0 的孤儿 cell 并进第 1 轮
  const prologue = turns.get(0);
  if (prologue !== undefined) {
    turns.delete(0);
    const first = turns.get(1) ?? { groups: [] };
    first.groups = [...prologue.groups, ...first.groups];
    turns.set(1, first);
  }

  for (const entry of [...turns.values(), ...standaloneCompactions]) {
    for (const group of entry.groups) {
      for (const laid of group.laid) {
        if (laid.callId === undefined) continue;
        const schema = input.callSchemas?.get(laid.callId)
          ?? schemaByName(input.callSchemas, laid.toolName);
        if (schema !== undefined) laid.cell.schemaDetail = JSON.stringify(schema, null, 2);
      }
    }
  }

  return [
    ...[...turns.entries()].map(([turn, entry]) => toTurnModel(turn, entry)),
    ...standaloneCompactions.map((entry) => toTurnModel(null, entry)),
  ].sort((left, right) => firstCellIndex(left) - firstCellIndex(right));
}

function schemaByName(callSchemas, name) {
  if (!callSchemas || name === undefined) return undefined;
  return callSchemas.get(`@${name}`);
}

function layoutEntryOrder(entry) {
  return entry.kind === 'system' && entry.change.kind === 'initial'
    ? Number.NEGATIVE_INFINITY
    : entry.seq;
}

function toTurnModel(turn, entry) {
  const groups = entry.groups.map(({ title, laid }) => {
    const description = groupDescription(laid);
    return {
      title,
      ...(description !== undefined ? { description } : {}),
      cells: laid.map((l) => l.cell),
    };
  });
  return { turn, groups };
}

/** 账本里最大 cell 序号（流式行续号用） */
export function lastCellIndex(turns) {
  let last = 0;
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) last = Math.max(last, cell.index);
    }
  }
  return last;
}

// ---------------------------------------------------------------- timeline

/**
 * 把时间线投影成三泳道模型。
 * @param {Array} turns 轨迹布局
 * @param {'sequence'|'duration'|'time'|'actual'} mode
 * @returns {object|null}
 */
export function deriveTrajectoryTimeline(turns, mode = 'sequence') {
  if (mode !== 'sequence') {
    return deriveTimedTimeline(turns, mode === 'duration' || mode === 'actual', mode === 'duration');
  }
  const spans = [];
  const turnBoundaries = [];
  for (const turn of turns) {
    const cells = turn.groups.flatMap((group) => group.cells.filter((cell) => cell.requestOnly !== true));
    if (cells.length === 0) continue;
    if (turn.turn !== null) turnBoundaries.push({ turn: turn.turn, time: spans.length });
    spans.push(...cells.map((cell, offset) => ({
      start: spans.length + offset,
      end: spans.length + offset + 1,
      index: cell.index,
      isError: cell.isError === true,
      kind: cell.kind,
      label: cell.text,
      lane: laneFor(cell.kind),
    })));
  }
  if (spans.length === 0) return null;
  return { start: 0, end: spans.length, spans, turnBoundaries };
}

function laneFor(kind) {
  if (kind === 'tool' || kind === 'subtool') return 2;
  if (kind === 'message' || kind === 'compacted') return 1;
  return 0;
}

function cellRange(cell) {
  if (!Number.isFinite(cell.startedAt)) return null;
  const durationMs = Number.isFinite(cell.timeSeconds) ? Math.max(0, cell.timeSeconds * 1000) : 0;
  return { start: cell.startedAt, end: cell.startedAt + durationMs };
}

function deriveTimedTimeline(turns, actualDuration, compressIdle) {
  const timedTurns = turns.flatMap((turn) => {
    const rawSpans = turn.groups.flatMap((group) => group.cells.flatMap((cell) => {
      if (cell.requestOnly === true) return [];
      const range = cellRange(cell);
      return range === null ? [] : [{
        ...range,
        index: cell.index,
        isError: cell.isError === true,
        kind: cell.kind,
        label: cell.text,
        lane: laneFor(cell.kind),
      }];
    }));
    return rawSpans.length === 0 ? [] : [{ turn: turn.turn, rawSpans }];
  });
  const rawSpans = timedTurns.flatMap((turn) => turn.rawSpans);
  if (rawSpans.length === 0) return null;

  const removedIdleBySpan = new Map();
  let removedIdle = 0;
  let coveredUntil = null;
  for (const span of [...rawSpans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (compressIdle && coveredUntil !== null && span.start > coveredUntil) {
      removedIdle += span.start - coveredUntil;
    }
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans = [];
  const turnBoundaries = [];
  for (const turn of timedTurns) {
    const projected = turn.rawSpans.map((span) => {
      const offset = removedIdleBySpan.get(span) ?? 0;
      return {
        ...span,
        start: span.start - offset,
        end: (actualDuration ? span.end : span.start) - offset,
      };
    });
    spans.push(...projected);
    if (turn.turn !== null) {
      turnBoundaries.push({ turn: turn.turn, time: Math.min(...projected.map((s) => s.start)) });
    }
  }
  return {
    start: Math.min(...spans.map((s) => s.start)),
    end: Math.max(...spans.map((s) => s.end)),
    spans,
    turnBoundaries,
  };
}

/** 时间线区间命中的记录序号集合 */
export function trajectoryTimelineFocusIndexes(turns, range, mode = 'sequence') {
  const model = deriveTrajectoryTimeline(turns, mode);
  return new Set(
    (model?.spans ?? [])
      .filter((span) => span.start <= range.end && span.end >= range.start)
      .map((span) => span.index),
  );
}

// ---------------------------------------------------------------- 虚拟行

const CONTENT_ROW_HEIGHT = 30;
const COLLAPSED_SUMMARY_HEIGHT = 20;
const TERMINAL_BOUNDARY_HEIGHT = 9;

export function trajectoryVirtualRecordKey(record) {
  const identity = encodeURIComponent(trajectoryRecordId(record.cell));
  return record.collapsedSummaryKind === undefined
    ? identity
    : `${identity} summary ${record.collapsedSummaryKind}`;
}

/** 把零高的 requestOnly 行挂到下一个内容行上（上游 groupTrajectoryVirtualRows） */
export function groupTrajectoryVirtualRows(records) {
  const rows = [];
  let pending = [];
  for (const [logicalIndex, record] of records.entries()) {
    const entry = { logicalIndex, record };
    if (record.cell.requestOnly === true) {
      pending.push(entry);
      continue;
    }
    const entries = [...pending, entry];
    pending = [];
    rows.push({
      entries,
      height: record.collapsedSummaryKind === undefined
        ? CONTENT_ROW_HEIGHT
        : COLLAPSED_SUMMARY_HEIGHT,
      key: trajectoryVirtualRecordKey(record),
    });
  }
  if (pending.length > 0) {
    rows.push({
      entries: pending,
      height: TERMINAL_BOUNDARY_HEIGHT,
      key: pending.map((c) => trajectoryVirtualRecordKey(c.record)).join('|'),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- 搜索索引

function searchableJson(value) {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function markdownPreview(cell) {
  if (cell.previewMarkdown === undefined) return '';
  const preview = trajectoryPreviewText(cell.previewMarkdown);
  if (cell.text === '') return preview;
  return preview === '' ? cell.text : `${cell.text} · ${preview}`;
}

function resultPreview(cell) {
  return cell.resultPreviewMarkdown === undefined
    ? (cell.result ?? '')
    : trajectoryPreviewText(cell.resultPreviewMarkdown);
}

function recordSources(turn, group, cell) {
  const blocks = [...(cell.sourceBlocks ?? []), ...(cell.outputBlocks ?? [])];
  return [
    turn === null ? 'between turns' : `turn ${turn}`,
    group,
    cell.kind,
    cell.kind === 'message' ? 'assistant' : '',
    cell.text,
    cell.previewMarkdown ?? '',
    cell.inputDetail ?? '',
    cell.outputDetail ?? '',
    cell.thinkingDetail ?? '',
    cell.schemaDetail ?? '',
    cell.result ?? '',
    cell.resultPreviewMarkdown ?? '',
    cell.callId ?? '',
    ...blocks.flatMap((block) => [
      block.type,
      block.content,
      block.callId ?? '',
      block.toolName ?? '',
      block.attachment?.name ?? '',
    ]),
    searchableJson(cell.messageSource),
    searchableJson(cell.promptDetail),
    searchableJson(cell.previousPromptDetail),
  ];
}

/** 增量全文索引：只有某条记录的来源变了才重新解析 Markdown。 */
export class TrajectorySearchIndex {
  constructor() {
    this.entries = new Map();
    this.layouts = undefined;
  }

  /**
   * 同步布局切片。
   * @param {Array} layouts 一个或多个布局数组
   * @returns {boolean} 索引版本是否变化
   */
  update(layouts) {
    if (this.layouts === layouts) return false;
    this.layouts = layouts;
    const seen = new Set();
    for (const turns of layouts) {
      for (const turn of turns) {
        for (const group of turn.groups) {
          for (const cell of group.cells) {
            if (cell.requestOnly === true) continue;
            const id = trajectoryRecordId(cell);
            const sources = recordSources(turn.turn, group.title, cell);
            const previous = this.entries.get(id);
            const entry = previous !== undefined && sameSources(previous.sources, sources)
              ? previous
              : {
                sources,
                text: [...sources, markdownPreview(cell), resultPreview(cell)]
                  .join('\n').toLocaleLowerCase(),
              };
            this.entries.set(id, entry);
            seen.add(id);
          }
        }
      }
    }
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) this.entries.delete(id);
    }
    return true;
  }

  /**
   * 匹配查询（空格分隔、全部命中才算）。
   * @param {string} query
   * @returns {Set<string>|null} 无查询时返回 null
   */
  search(query) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    const matches = new Set();
    for (const [id, entry] of this.entries) {
      if (terms.every((term) => entry.text.includes(term))) matches.add(id);
    }
    return matches;
  }
}

function sameSources(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
