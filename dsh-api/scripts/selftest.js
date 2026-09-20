#!/usr/bin/env node
// 端到端一致性自检：真起一个服务器进程 + 一个模拟插件进程，按规范逐条核对。
//   node scripts/selftest.js
// 不需要外部依赖，也不需要事先跑任何东西。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail && !ok ? `  —— ${detail}` : ''}`);
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, { timeout = 15000, interval = 200, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时（${timeout}ms）`);
    await sleep(interval);
  }
}

function startProc(cmd, args, env, tag) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (b) => { if (process.env.VERBOSE) process.stdout.write(`[${tag}] ${b}`); });
  p.stderr.on('data', (b) => { if (process.env.VERBOSE) process.stderr.write(`[${tag}:err] ${b}`); });
  return p;
}

const kill = (p) => { try { p?.kill('SIGKILL'); } catch { /* 忽略 */ } };

async function main() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-selftest-'));
  const adminKey = 'dshadm_' + crypto.randomBytes(32).toString('base64url');
  const instanceKey = 'dshk_' + crypto.randomBytes(32).toString('base64url');
  const instanceId = 'dsh-' + crypto.randomBytes(6).toString('hex');
  const base = `http://127.0.0.1:${port}/dsh-api`;

  // 预置配置：关掉 TLS、缩短离线判定，方便测超时
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    host: '127.0.0.1',
    port,
    basePath: '/dsh-api',
    tls: { cert: '', key: '', watchMs: 0 },
    dataDir,
    offlineAfterMs: 6000,
    helloTimeoutMs: 5000,
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'admin-key.txt'), adminKey + '\n', { mode: 0o600 });

  console.log(`\n自检环境：端口 ${port}，数据目录 ${dataDir}\n`);

  const server = startProc(process.execPath, ['server.js'], { DSH_RELAY_DATA_DIR: dataDir, DSH_RELAY_LOG_LEVEL: 'warn' }, 'server');
  const procs = [server];

  const api = async (p, { method = 'GET', body, headers = {}, noAuth = false } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(noAuth ? {} : { 'x-admin-key': adminKey }),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: res.status, data };
  };
  const call = async (method, params = {}) => {
    const { data } = await api(`/instances/${instanceId}/request`, { method: 'POST', body: { method, params } });
    return data;
  };
  const instances = async () => (await api('/instances')).data.items || [];

  try {
    // ---------------------------------------------------------- 启动与鉴权
    console.log('【端点与鉴权】');
    const health = await waitFor(async () => {
      const r = await api('/health');
      return r.status === 200 ? r.data : null;
    }, { label: '服务器启动' }).catch((e) => { check('服务器启动', false, e.message); return null; });
    check('GET /health 返回协议版本', health?.protocol === 1, JSON.stringify(health));
    check('未带管理密钥访问 /instances 返回 401', (await api('/instances', { noAuth: true })).status === 401);
    check('错误管理密钥访问 /instances 返回 401', (await api('/instances', { headers: { 'x-admin-key': 'dshadm_wrong' } })).status === 401);

    const badKey = await fetch(`${base}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, instanceId, frames: [] }),
    });
    check('HTTP 载体无 key 返回 401', badKey.status === 401, `实际 ${badKey.status}`);
    const badInbox = await fetch(`${base}/inbox?instanceId=${instanceId}&key=dshk_wrong`);
    check('HTTP 载体 key 错误返回 401', badInbox.status === 401, `实际 ${badInbox.status}`);

    const wsBad = await new Promise((resolve) => {
      const req = net.connect(port, '127.0.0.1', () => {
        req.write(`GET /dsh-api/ws?v=1&key=dshk_wrong HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let buf = '';
      req.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n\r\n')) { req.destroy(); resolve(buf.split('\r\n')[0]); } });
      req.on('error', () => resolve('error'));
      setTimeout(() => { req.destroy(); resolve('timeout'); }, 4000);
    });
    check('WebSocket 携带错误 key 时升级前即被拒（401）', wsBad.includes('401'), wsBad);

    // ---------------------------------------------------------- 配对
    console.log('\n【配对与实例注册】');
    const reg = await api('/keys', { method: 'POST', body: { key: instanceKey, label: '自检机器' } });
    check('POST /keys 登记成功', reg.data?.ok === true, JSON.stringify(reg.data));
    const keyList = await api('/keys');
    check('GET /keys 只返回指纹，不回显完整 key',
      keyList.data.items?.[0] && !JSON.stringify(keyList.data).includes(instanceKey),
      JSON.stringify(keyList.data).slice(0, 200));

    // ---------------------------------------------------------- WebSocket 载体
    console.log('\n【传输层 A：WebSocket】');
    const simWs = startProc(process.execPath, [
      'sim/dsh-sim.js', '--endpoint', base, '--ws', '--key', instanceKey, '--instance', instanceId, '--name', '自检机器',
    ], {}, 'sim-ws');
    procs.push(simWs);

    const online = await waitFor(async () => (await instances()).find((i) => i.instanceId === instanceId && i.online), { label: '实例上线' })
      .catch((e) => { check('hello → hello.ack → 实例上线', false, e.message); return null; });
    check('hello → hello.ack → 实例上线', !!online);
    check('传输标记为 websocket', online?.transport === 'websocket', online?.transport);
    check('自动订阅了 instance/sessions 等 topic',
      ['instance', 'sessions'].every((t) => (online?.subscriptions?.topics || []).includes(t)),
      JSON.stringify(online?.subscriptions));
    check('能力协商结果已回传', Object.keys(online?.capabilities || {}).length > 5);

    // ---------------------------------------------------------- 方法调用
    console.log('\n【方法目录】');
    const ping = await call('instance.ping');
    check('instance.ping', ping?.ok && ping.result?.pong === true, JSON.stringify(ping));
    const list = await call('session.list');
    const sid = list?.result?.items?.[0]?.sessionId;
    check('session.list 返回会话', !!sid, JSON.stringify(list).slice(0, 200));
    const unknown = await call('nope.nope');
    check('未知方法返回 unknown_method 且 details.methods 非空',
      unknown?.error?.code === 'unknown_method' && (unknown.error.details?.methods || []).length > 10,
      JSON.stringify(unknown));

    const badParams = await call('session.history', { sessionId: sid });
    check('session.history 缺 throughSeq 返回 invalid_params', badParams?.error?.code === 'invalid_params', JSON.stringify(badParams));

    const noSession = await call('session.get', { sessionId: 'session-does-not-exist' });
    check('不存在的会话返回 session_not_found', noSession?.error?.code === 'session_not_found', JSON.stringify(noSession));

    // ---------------------------------------------------------- 事件流与流式
    console.log('\n【订阅 / 事件流 / 流式输出】');
    await api(`/instances/${instanceId}/subscribe`, { method: 'POST', body: { sessions: [sid], assistantStream: true } });
    const prompt = await call('session.prompt', { sessionId: sid, text: '自检：跑一下测试' });
    check('session.prompt 被接受', prompt?.ok && prompt.result?.accepted === true, JSON.stringify(prompt));

    const statusEvent = await waitFor(async () => {
      const r = await api(`/instances/${instanceId}/events?since=0&limit=200`);
      return (r.data.items || []).find((f) => f.kind === 'session/status' && f.data?.running === true);
    }, { label: 'session/status running 事件' }).catch(() => null);
    check('收到 session/status(running=true) 事件', !!statusEvent);

    const stream = await waitFor(async () => {
      const r = await api(`/instances/${instanceId}/session-events/${sid}`);
      return (r.data.stream?.text || '').length > 10 ? r.data.stream : null;
    }, { timeout: 20000, label: '助手流式片段' }).catch(() => null);
    check('收到并累积 session/assistant-stream 片段', !!stream, JSON.stringify(stream).slice(0, 160));

    const assistantEvent = await waitFor(async () => {
      const r = await api(`/instances/${instanceId}/events?since=0&limit=300`);
      return (r.data.items || []).find((f) => f.kind === 'session/event' && f.data?.type === 'assistant/message');
    }, { timeout: 20000, label: 'assistant/message 事件' }).catch(() => null);
    check('收到 session/event(assistant/message) 事件溯源', !!assistantEvent);

    // 按 seq 去重
    const evAll = (await api(`/instances/${instanceId}/events?since=0&limit=2000`)).data.items || [];
    const seqs = evAll.map((f) => f.seq);
    check('事件 seq 单调递增且不重复', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `${seqs.length} 条`);

    // ---------------------------------------------------------- 审批
    console.log('\n【审批应答】');
    await call('command.run', { sessionId: sid, line: '/demo-approval' });
    const pending = await waitFor(async () => {
      const d = (await api(`/instances/${instanceId}`)).data;
      return (d.pendingDecisions || [])[0];
    }, { label: '审批请求' }).catch(() => null);
    check('approval/request 事件被服务器记录为待决', !!pending?.requestId, JSON.stringify(pending));
    if (pending) {
      const answered = await call('approval.respond', { requestId: pending.requestId, outcome: 'allowed-once' });
      check('approval.respond 返回 matched=true', answered?.result?.matched === true, JSON.stringify(answered));
      const after = (await api(`/instances/${instanceId}`)).data;
      check('应答后待决列表清空', (after.pendingDecisions || []).length === 0, JSON.stringify(after.pendingDecisions));
    }

    // ---------------------------------------------------------- 断线重连补发
    console.log('\n【断线 / 补发 / 离线判定】');
    const before = (await instances())[0];
    kill(simWs);
    const offline = await waitFor(async () => {
      const i = (await instances()).find((x) => x.instanceId === instanceId);
      return i && !i.online ? i : null;
    }, { timeout: 20000, label: '实例离线' }).catch(() => null);
    check('链路断开后实例被判定为离线', !!offline);
    check('离线前记录了水位 seq', (before?.lastSeq || 0) > 0, String(before?.lastSeq));
    check('离线状态下下发请求返回 instance_offline',
      (await call('instance.ping'))?.error?.code === 'instance_offline');

    // 重连：同一个 key / instanceId，服务器要认得出来
    const simWs2 = startProc(process.execPath, [
      'sim/dsh-sim.js', '--endpoint', base, '--ws', '--key', instanceKey, '--instance', instanceId, '--name', '自检机器',
    ], {}, 'sim-ws2');
    procs.push(simWs2);
    const reonline = await waitFor(async () => (await instances()).find((i) => i.instanceId === instanceId && i.online), { label: '重连' }).catch(() => null);
    check('同一 key/instanceId 重连后重新上线', !!reonline);
    kill(simWs2);
    await sleep(500);

    // ---------------------------------------------------------- HTTP 载体
    console.log('\n【传输层 B：HTTP 长轮询】');
    const simHttp = startProc(process.execPath, [
      'sim/dsh-sim.js', '--endpoint', base, '--http', '--key', instanceKey, '--instance', instanceId, '--name', '自检机器',
    ], {}, 'sim-http');
    procs.push(simHttp);
    const httpOnline = await waitFor(async () => (await instances()).find((i) => i.instanceId === instanceId && i.online && i.transport === 'http'), { label: 'HTTP 载体上线' })
      .catch((e) => { check('HTTP 长轮询握手成功', false, e.message); return null; });
    check('HTTP 长轮询握手成功', !!httpOnline);
    const httpPing = await call('instance.ping');
    check('HTTP 载体上 request/response 可用', httpPing?.ok && httpPing.result?.pong === true, JSON.stringify(httpPing));
    // 模拟器进程重启后会话是新的，必须重新拉一次列表
    const httpList = await call('session.list');
    const httpSid = httpList?.result?.items?.[0]?.sessionId;
    check('HTTP 载体上 session.list 可用', !!httpSid, JSON.stringify(httpList).slice(0, 160));
    const httpPrompt = await call('session.prompt', { sessionId: httpSid, text: '自检：HTTP 载体' });
    check('HTTP 载体上 session.prompt 可用', httpPrompt?.result?.accepted === true, JSON.stringify(httpPrompt));

    // bye：HTTP 载体没有 socket 关闭信号，只能靠 bye 标记离线
    simHttp.kill('SIGINT');
    const byeOffline = await waitFor(async () => {
      const i = (await instances()).find((x) => x.instanceId === instanceId);
      return i && !i.online ? i : null;
    }, { timeout: 20000, label: 'bye 后离线' }).catch(() => null);
    check('HTTP 载体收到 bye 后标记离线', !!byeOffline);

    // ---------------------------------------------------------- 多机器隔离
    console.log('\n【多机器隔离】');
    const key2 = 'dshk_' + crypto.randomBytes(32).toString('base64url');
    const id2 = 'dsh-' + crypto.randomBytes(6).toString('hex');
    await api('/keys', { method: 'POST', body: { key: key2, label: '第二台' } });
    // 第一台刚才因为测 bye 已经离线，这里重新拉起来，两台同时在线的场景才有意义
    const sim1b = startProc(process.execPath, [
      'sim/dsh-sim.js', '--endpoint', base, '--ws', '--key', instanceKey, '--instance', instanceId, '--name', '自检机器',
    ], {}, 'sim-1b');
    procs.push(sim1b);
    const sim2 = startProc(process.execPath, [
      'sim/dsh-sim.js', '--endpoint', base, '--ws', '--key', key2, '--instance', id2, '--name', '第二台',
    ], {}, 'sim-2');
    procs.push(sim2);
    const two = await waitFor(async () => {
      const list2 = await instances();
      return list2.length >= 2 && list2.every((i) => i.online) ? list2 : null;
    }, { label: '两台机器同时在线' }).catch(() => null);
    check('多台机器可同时在线且各自独立', !!two, `实际 ${(await instances()).length} 台`);
    const list2Res = await api(`/instances/${id2}/request`, { method: 'POST', body: { method: 'session.list' } });
    check('可分别向第二台下发请求', list2Res.data?.ok === true);

    // ---------------------------------------------------------- 编辑已登记的 key
    console.log('\n【key 编辑】');
    const beforeEdit = (await api('/keys')).data.items || [];
    const editable = beforeEdit.find((k) => k.instanceId === id2);
    const renamed = await api(`/keys/${editable.id}`, { method: 'PATCH', body: { label: '改过名的第二台' } });
    check('PATCH /keys/:id 能改备注名', renamed.status === 200 && renamed.data?.item?.label === '改过名的第二台');
    const afterRename = (await instances()).find((i) => i.instanceId === id2);
    check('在线实例的名字同步更新', afterRename?.label === '改过名的第二台', afterRename?.label);

    const swapped = 'dshk_' + crypto.randomBytes(32).toString('base64url');
    const swapRes = await api(`/keys/${editable.id}`, { method: 'PATCH', body: { key: swapped } });
    check('PATCH /keys/:id 能换 key', swapRes.status === 200);
    const clash = await api(`/keys/${editable.id}`, { method: 'PATCH', body: { key: instanceKey } });
    check('换成已被别的机器占用的 key 会被拒', clash.status === 400);
    const badPrefix = await api(`/keys/${editable.id}`, { method: 'PATCH', body: { key: 'not-a-key' } });
    check('拒绝不符合前缀的 key', badPrefix.status === 400);
    const missing = await api('/keys/nope-nope', { method: 'PATCH', body: { label: 'x' } });
    check('编辑不存在的条目返回 404', missing.status === 404);
    const noAuth = await api(`/keys/${editable.id}`, { method: 'PATCH', body: { label: 'x' }, noAuth: true });
    check('未带管理密钥不能编辑', noAuth.status === 401);
    // 换回去，后面的吊销用例还要用原来那把 key 重连
    await api(`/keys/${editable.id}`, { method: 'PATCH', body: { key: key2, label: '第二台' } });

    // ---------------------------------------------------------- 吊销
    console.log('\n【key 吊销】');
    const keys = (await api('/keys')).data.items || [];
    const target = keys.find((k) => k.instanceId === id2 || k.label === '第二台');
    await api(`/keys/${target.id}`, { method: 'DELETE' });
    kill(sim2);
    await sleep(300);
    const sim2b = startProc(process.execPath, [
      'sim/dsh-sim.js', '--endpoint', base, '--ws', '--key', key2, '--instance', id2, '--name', '第二台',
    ], {}, 'sim-2b');
    procs.push(sim2b);
    await sleep(3500);
    const revoked = (await instances()).find((i) => i.instanceId === id2);
    check('吊销后该机器无法再上线', !revoked || !revoked.online, JSON.stringify(revoked?.online));
    const otherStill = (await instances()).find((i) => i.instanceId === instanceId);
    check('吊销其他机器的 key 不影响本机', !!otherStill);
  } catch (err) {
    check('自检执行过程', false, err.stack || err.message);
  } finally {
    for (const p of procs) kill(p);
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`自检完成：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('\n未通过项：');
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('全部通过 ✓');
}

main();
