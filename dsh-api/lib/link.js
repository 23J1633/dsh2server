// 链路（link）抽象：同一个实例可以同时连多个服务器端点，但本实现只承载
// "插件 → 本服务器"这一条链路。两种载体（WebSocket / HTTP 长轮询）在这里统一，
// 上层的帧处理逻辑完全共用（规范 §1.2「两种传输，一套协议」）。
import { log } from './log.js';

let linkSeq = 0;

export class Link {
  constructor({ instanceId, transport, endpoint, insecure = false }) {
    this.id = `link-${++linkSeq}`;
    this.instanceId = instanceId;
    this.transport = transport;          // websocket | http
    this.endpoint = endpoint;            // 本服务器自己的基地址
    this.insecure = insecure;
    this.state = 'connecting';           // connecting | connected | idle | disposed
    this.connectedSince = null;
    this.lastInboundAt = 0;
    this.attempts = 0;
    this.wsFailures = 0;
    this.serverAckSeq = 0;               // 插件通过 ack / ?cursor= 回报的下行水位
    this.lastError = null;
    this.rejected = null;                // 非 null = 被本服务器拒绝（key 错误/已吊销）
  }

  noteInbound() {
    this.lastInboundAt = Date.now();
  }

  markConnected() {
    this.state = 'connected';
    this.connectedSince = Date.now();
    this.lastError = null;
    this.rejected = null;
  }

  markDisposed(reason) {
    this.state = 'disposed';
    this.lastError = reason || null;
  }

  // eslint-disable-next-line no-unused-vars
  send(_frame) { throw new Error('not implemented'); }

  // eslint-disable-next-line no-unused-vars
  close(_code, _reason) { this.markDisposed(); }

  /** instance.info 里 connection 字段的形态（规范 §9.1） */
  view(subscriptions) {
    return {
      endpoint: this.endpoint,
      configuredEndpoint: this.endpoint,
      insecure: this.insecure,
      state: this.state,
      transport: this.transport,
      connectedSince: this.connectedSince,
      attempts: this.attempts,
      wsFailures: this.wsFailures,
      lastInboundAt: this.lastInboundAt || null,
      serverAckSeq: this.serverAckSeq,
      subscriptions,
      rejected: this.rejected,
      lastError: this.lastError,
    };
  }
}

/** WebSocket 载体：双向、低延迟，首选。 */
export class WsLink extends Link {
  constructor({ instanceId, endpoint, insecure, socket }) {
    super({ instanceId, transport: 'websocket', endpoint, insecure });
    this.socket = socket;
  }

  send(frame) {
    if (this.state === 'disposed') return false;
    const { socket } = this;
    if (!socket || socket.readyState !== socket.OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      log.warn(`[ws] 发送失败 ${this.instanceId}: ${err.message}`);
      return false;
    }
  }

  close(code, reason) {
    this.markDisposed(reason);
    try { this.socket?.close(code ?? 1000, reason); } catch { /* 忽略 */ }
  }
}

/**
 * HTTP 长轮询载体：没有常驻 socket，用一个内存队列 + 挂起中的 inbox 请求来模拟推送。
 * 空响应也算心跳，所以"最后一次轮询时间"就是在线依据（规范 §5.2）。
 */
export class HttpLink extends Link {
  constructor({ instanceId, endpoint, insecure, waitMs = 25000 }) {
    super({ instanceId, transport: 'http', endpoint, insecure });
    this.queue = [];          // 待发帧
    this.waiters = new Set(); // 挂起中的 inbox 响应
    this.waitMs = waitMs;
  }

  send(frame) {
    if (this.state === 'disposed') return false;
    this.queue.push(frame);
    // 上限保护：插件长时间不轮询时不要把内存吃光
    if (this.queue.length > 5000) this.queue.splice(0, this.queue.length - 5000);
    this.flush();
    return true;
  }

  /** 把队列排空给所有挂起的 inbox（规范 §5.2：inbox 被调用时把它排空） */
  flush() {
    if (!this.waiters.size) return;
    const frames = this.queue.splice(0, this.queue.length);
    for (const w of [...this.waiters]) {
      this.waiters.delete(w);
      w(frames);
    }
  }

  /** 挂起等待新帧，超时返回空数组 */
  wait(waitMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (frames) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve(frames);
      };
      const timer = setTimeout(() => finish([]), waitMs);
      if (this.queue.length) finish(this.queue.splice(0, this.queue.length));
      else this.waiters.add(finish);
    });
  }

  close() {
    this.markDisposed();
    this.flush();
  }
}
