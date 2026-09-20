#!/usr/bin/env node
// 转录装配的回归测试：把两种真实事件形态喂给 model.js，核对产出的对话节点。
//
// 这两种形态都是 2026-09-15 从一台真实 dsh（插件 0.1.0）上抓下来的，不是猜的：
//   A. session.history 的「消息对齐记录」—— content 是内容块数组
//      （text / reasoning / tool-call / tool-result），seq 是页内序号、time 为 0
//   B. 实时 session/event 的原始日志事件 —— turn/start、tool/call、tool/result …
//
// 夹具是合成的（不含任何真实会话内容），但字段名与嵌套结构一字不差。
import assert from 'node:assert/strict';
import { buildTranscript, groupByCwd, sessionStatus } from '../public/js/model.js';

let pass = 0;
const results = [];
const check = (name, fn) => {
  try { fn(); pass += 1; results.push(`  ✓ ${name}`); }
  catch (e) { results.push(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); process.exitCode = 1; }
};

// ---------------------------------------------------------------- 夹具

/** A：消息对齐记录。seq 是页内序号（0 起），time 恒为 0，带 synthetic 标记。 */
const alignedHistory = [
  { type: 'user/message', seq: 0, time: 0, synthetic: true,
    data: { derived: true, message: { role: 'user', content: [{ type: 'text', text: '把服务跑起来' }] } } },
  { type: 'assistant/message', seq: 1, time: 0, synthetic: true,
    data: { derived: true, message: { role: 'assistant', content: [
      { type: 'reasoning', text: '先看看端口占用情况。\n第二行也要有。' },
      { type: 'tool-call', id: 'call_a1', name: 'pwsh', arguments: '{"command":"Get-NetTCPConnection -LocalPort 8080"}' },
    ] } } },
  { type: 'user/message', seq: 2, time: 0, synthetic: true,
    data: { derived: true, message: { role: 'user', content: [
      { type: 'tool-result', toolCallId: 'call_a1', content: [{ type: 'text', text: '没有监听\n' }], isError: false },
    ] } } },
  { type: 'assistant/message', seq: 3, time: 0, synthetic: true,
    data: { derived: true, message: { role: 'assistant', content: [
      { type: 'reasoning', text: '端口没起来，写个文件再启动。' },
      { type: 'tool-call', id: 'call_a2', name: 'edit', arguments: '{"file_path":"C:\\\\p\\\\a.php","old_string":"x","new_string":"y"}' },
    ] } } },
  { type: 'user/message', seq: 4, time: 0, synthetic: true,
    data: { derived: true, message: { role: 'user', content: [
      { type: 'tool-result', toolCallId: 'call_a2', content: [{ type: 'text', text: '已应用 1 处修改' }], isError: false, meta: { added: 1, removed: 1 } },
    ] } } },
  { type: 'assistant/message', seq: 5, time: 0, synthetic: true,
    data: { derived: true, message: { role: 'assistant', content: [
      { type: 'text', text: '已经修好了，8080 现在通了。' },
    ] } } },
];

/** B：实时原始日志事件。 */
const rawEvents = [
  { type: 'turn/start', seq: 10, time: 1000, data: { turn: 1 } },
  { type: 'user/message', seq: 11, time: 1001, data: { turn: 1, message: { role: 'user', content: '跑测试' } } },
  { type: 'step/start', seq: 12, time: 1002, data: { turn: 1, step: 1 } },
  { type: 'tool/call', seq: 13, time: 1003, data: { turn: 1, callId: 'call_b1', name: 'bash', arguments: '{"command":"pnpm test"}' } },
  { type: 'tool/result', seq: 14, time: 1004, data: { callId: 'call_b1', message: '38 passed\n', meta: { exitCode: 0 } } },
  { type: 'assistant/message', seq: 15, time: 1005, data: { turn: 1, step: 1, message: { role: 'assistant', content: '全部通过。' }, usage: { inputTokens: 10, outputTokens: 4 } } },
  { type: 'turn/end', seq: 16, time: 1006, data: { turn: 1, reason: 'completed' } },
  { type: 'turn/start', seq: 17, time: 1007, data: { turn: 2 } },
  { type: 'user/message', seq: 18, time: 1008, data: { turn: 2, message: { role: 'user', content: '再跑一次' } } },
  // 真实插件的 TurnEndReason 是可辨识联合；这里用的就是失败那一支的原始形态
  { type: 'turn/end', seq: 19, time: 1009, data: { turn: 2, reason: { kind: 'error', error: { code: 'UNKNOWN', message: '连不上 provider' } } } },
];

const compact = (events, opts = {}) => buildTranscript(events, null, { compact: true, openTurns: new Set(), running: false, ...opts });
const kinds = (nodes) => nodes.map((n) => n.kind);

// ---------------------------------------------------------------- A：消息对齐记录

check('A1 工具结果块不会被渲染成用户气泡', () => {
  const nodes = compact(alignedHistory);
  const users = nodes.filter((n) => n.kind === 'user');
  assert.equal(users.length, 1, `用户气泡应只有 1 个，实际 ${users.length}`);
  assert.equal(users[0].text, '把服务跑起来');
});

check('A2 tool-call 块生成工具节点，工具结果按 toolCallId 挂回去', () => {
  const nodes = compact(alignedHistory);
  const tools = nodes.filter((n) => n.kind === 'tool');
  assert.equal(tools.length, 2, `工具节点应为 2，实际 ${tools.length}`);
  assert.deepEqual(tools.map((t) => t.name), ['pwsh', 'edit']);
  assert.equal(tools[0].result?.text.trim(), '没有监听');
  assert.equal(tools[0].state, 'ok');
  assert.equal(tools[0].args.command, 'Get-NetTCPConnection -LocalPort 8080');
  assert.equal(tools[1].result?.text, '已应用 1 处修改');
});

check('A3 reasoning 块各自成为思考节点，且不被折进工具行', () => {
  const nodes = compact(alignedHistory);
  const thinks = nodes.filter((n) => n.kind === 'reasoning');
  assert.equal(thinks.length, 2);
  assert.ok(thinks[0].text.startsWith('先看看端口占用'));
});

check('A4 索引字段不走 JSON.parse 也能拿到（arguments 是字符串）', () => {
  const nodes = compact(alignedHistory);
  const tool = nodes.find((n) => n.name === 'edit');
  assert.equal(tool.args.file_path, 'C:\\p\\a.php');
});

check('A5 已结束的轮次折叠中间过程，只留最终答复', () => {
  const nodes = compact(alignedHistory);
  // 轮末的「本轮文件改动」行不参与折叠，永远留在最后
  assert.deepEqual(kinds(nodes), ['user', 'turn-process', 'reasoning', 'tool', 'reasoning', 'tool', 'assistant-step', 'turn-files']);
  const fold = nodes.find((n) => n.kind === 'turn-process');
  assert.equal(fold.toolCalls, 2);
  assert.equal(fold.messages, 0);
  assert.ok(nodes.slice(1).filter((n) => n.hidden).length >= 4, '过程节点默认应被 hidden 收起');
  const answer = nodes.filter((n) => n.kind === 'assistant-step');
  assert.equal(answer.length, 1);
  assert.equal(answer[0].hidden, undefined);
  assert.ok(answer[0].text.includes('已经修好了'));
});

check('A5b 轮末给出本轮改动过的文件与增删统计', () => {
  const nodes = compact(alignedHistory);
  const row = nodes.find((n) => n.kind === 'turn-files');
  assert.ok(row, '应有 turn-files 节点');
  assert.equal(row.files.length, 1);
  assert.equal(row.files[0].name, 'a.php');
  assert.equal(row.files[0].added, 1);
  assert.equal(row.files[0].removed, 1);
});

check('A5c 插件在 turn/end 给出 files 时优先用插件的', () => {
  const withFiles = [
    ...alignedHistory,
    { type: 'turn/end', seq: 9, time: 9, data: { turn: 1, reason: 'completed', files: [{ path: 'x/y.ts', added: 9, removed: 2 }] } },
  ];
  const row = compact(withFiles).find((n) => n.kind === 'turn-files');
  assert.equal(row.files.length, 1);
  assert.equal(row.files[0].name, 'y.ts');
  assert.equal(row.files[0].added, 9);
});

check('A6 展开轮次后过程节点仍在，只是不再 hidden', () => {
  const nodes = compact(alignedHistory, { openTurns: new Set([1]) });
  const members = nodes.filter((n) => n.member);
  assert.ok(members.length >= 4);
  assert.ok(members.every((n) => n.hidden === false));
});

check('A7 标准模式下不折叠', () => {
  const nodes = buildTranscript(alignedHistory, null, { compact: false, openTurns: new Set(), running: false });
  assert.ok(!kinds(nodes).includes('turn-process'));
  assert.ok(nodes.every((n) => !n.hidden));
});

check('A8 流式片段作为最后一轮的进行中节点', () => {
  const nodes = buildTranscript(alignedHistory, { text: '正在输出', streaming: true },
    { compact: true, openTurns: new Set(), running: true });
  const live = nodes.find((n) => n.key === 'live');
  assert.ok(live, '应存在 live 节点');
  assert.equal(live.streaming, true);
  assert.equal(live.text, '正在输出');
});

// ---------------------------------------------------------------- B：原始日志事件

check('B1 turn/start 与 turn/end 划分轮次并折叠过程', () => {
  const nodes = compact(rawEvents);
  assert.deepEqual(kinds(nodes), ['user', 'turn-process', 'tool', 'assistant-step', 'user', 'turn-error']);
  const fold = nodes.find((n) => n.kind === 'turn-process');
  assert.equal(fold.toolCalls, 1, '第一轮折了 1 个工具');
});

check('B2 工具结果按 callId 挂回调用并保留 meta', () => {
  const nodes = compact(rawEvents);
  const tool = nodes.find((n) => n.kind === 'tool');
  assert.equal(tool.callId, 'call_b1');
  assert.equal(tool.result.text, '38 passed\n');
  assert.equal(tool.result.meta.exitCode, 0);
});

check('B3 助手消息带 usage 与本轮用时', () => {
  const nodes = compact(rawEvents);
  const step = nodes.find((n) => n.kind === 'assistant-step');
  assert.equal(step.usage.outputTokens, 4);
  assert.equal(step.durationMs, 6);
});

check('B3b turn 内的内容块用户消息不会误开新轮次', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 101, data: { message: { role: 'user', content: [{ type: 'text', text: '你好' }] } } },
    { type: 'assistant/message', seq: 3, time: 102, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '在' }] } } },
    { type: 'turn/end', seq: 4, time: 106, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const nodes = compact(events);
  assert.equal(nodes.find((node) => node.kind === 'user').turn, 1);
  assert.equal(nodes.find((node) => node.kind === 'assistant-step').turn, 1);
  assert.equal(nodes.find((node) => node.kind === 'assistant-step').durationMs, 6);
});

check('B4 kind=error 的轮次留下失败标记，且带上 provider 的原文', () => {
  const nodes = compact(rawEvents);
  const err = nodes.find((n) => n.kind === 'turn-error');
  assert.equal(err.reason.kind, 'error');
  assert.equal(err.reason.message, '连不上 provider');
  assert.equal(err.reason.code, 'UNKNOWN');
});

check('B4b 正常结束（{kind:completed}）不产生任何失败提示', () => {
  // 真实插件把 `completed` 也包成对象，早前按字符串判等会导致每一轮都误报失败
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { turn: 1, message: { role: 'user', content: '你好' } } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: '在' } } },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const nodes = compact(events);
  assert.equal(nodes.filter((n) => n.kind === 'turn-error').length, 0);
  assert.equal(nodes.filter((n) => n.kind === 'turn-max-tokens').length, 0);
});

check('B4c 中断与达到上限都不算失败', () => {
  const aborted = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  ];
  assert.equal(compact(aborted).filter((n) => n.kind === 'turn-error').length, 0);

  const capped = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'max-tokens' } } },
  ];
  const nodes = compact(capped);
  assert.equal(nodes.filter((n) => n.kind === 'turn-error').length, 0);
  assert.equal(nodes.filter((n) => n.kind === 'turn-max-tokens').length, 1);
});

check('B5 未知事件类型透传忽略，不断流', () => {
  const withUnknown = [...rawEvents, { type: 'future/thing', seq: 20, time: 1010, data: { turn: 2, x: 1 } }];
  const nodes = compact(withUnknown);
  assert.equal(nodes.filter((n) => n.kind === 'user').length, 2);
});

check('B6 内容块数组与纯字符串两种消息体都认', () => {
  const mixed = [
    { type: 'user/message', seq: 1, time: 1, data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '块形式' }] } } },
    { type: 'user/message', seq: 2, time: 2, data: { turn: 1, message: { role: 'user', content: '字符串形式' } } },
  ];
  const nodes = compact(mixed);
  assert.deepEqual(nodes.map((n) => n.text), ['块形式', '字符串形式']);
});

check('B7 结果先于调用到达时降级为独立节点，不丢信息', () => {
  const orphan = [{ type: 'tool/result', seq: 1, time: 1, data: { callId: 'call_x', message: '孤立的输出' } }];
  const nodes = compact(orphan);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'tool-result');
  assert.equal(nodes[0].result.text, '孤立的输出');
});

check('B8 节点 key 唯一且稳定（同一输入两次装配结果一致）', () => {
  const a = compact(rawEvents).map((n) => n.key);
  const b = compact(rawEvents).map((n) => n.key);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length, 'key 不能重复');
});

// ---------------------------------------------------------------- 侧边栏派生

check('C1 会话按工作目录分组，空 cwd 排最后', () => {
  const groups = groupByCwd([
    { sessionId: 's1', cwd: 'D:\\a', updatedAt: 5 },
    { sessionId: 's2', cwd: 'D:\\b', updatedAt: 9 },
    { sessionId: 's3', cwd: null, updatedAt: 99 },
    { sessionId: 's4', cwd: 'D:\\a', updatedAt: 7 },
  ]);
  assert.deepEqual(groups.map((g) => g.cwd), ['D:\\b', 'D:\\a', null]);
  assert.deepEqual(groups[1].sessions.map((s) => s.sessionId), ['s4', 's1']);
});

check('C1b 有工作区注册表时按 sessionIds 分组，其余会话统一未分组', () => {
  const groups = groupByCwd([
    { sessionId: 's1', cwd: 'D:\\work\\app', updatedAt: 5 },
    { sessionId: 's2', cwd: 'D:/work/app', updatedAt: 9 },
    { sessionId: 's3', cwd: 'D:\\old\\app', updatedAt: 7 },
  ], [{ id: 'w1', path: 'D:\\work\\app', title: 'My App', sessionIds: ['s1', 's2'] }]);
  assert.deepEqual(groups.map((group) => group.label), ['My App', '未分组']);
  assert.deepEqual(groups[0].sessions.map((session) => session.sessionId), ['s2', 's1']);
  assert.deepEqual(groups[1].sessions.map((session) => session.sessionId), ['s3']);
});

check('C1c 无注册表时合并 Windows 路径的斜杠与大小写差异', () => {
  const groups = groupByCwd([
    { sessionId: 's1', cwd: 'D:\\Work\\App', updatedAt: 5 },
    { sessionId: 's2', cwd: 'd:/work/app/', updatedAt: 9 },
    { sessionId: 's3', cwd: 'D:\\other', updatedAt: 7 },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((group) => group.sessions.some((session) => session.sessionId === 's1')).sessions
    .map((session) => session.sessionId), ['s2', 's1']);
});

check('C2 状态点优先级：审批 > 提问 > 运行中 > 空闲', () => {
  const s = { sessionId: 's1', running: true };
  assert.equal(sessionStatus(s, { pendingDecisions: [] }).state, 'ongoing');
  assert.equal(sessionStatus(s, { pendingDecisions: [{ kind: 'question', sessionId: 's1' }] }).state, 'question');
  assert.equal(sessionStatus(s, { pendingDecisions: [{ kind: 'approval', sessionId: 's1' }] }).state, 'approval');
  assert.equal(sessionStatus({ sessionId: 's1' }, {}).state, 'done');
});

// ---------------------------------------------------------------- 汇总

console.log(results.join('\n'));
console.log(`\n${'─'.repeat(56)}`);
console.log(`转录回归：${pass}/${results.length} 通过`);
if (process.exitCode) console.log('存在失败项');
