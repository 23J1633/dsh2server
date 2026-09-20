// 实例 key 白名单 —— 中转服务器持久化的认证材料。
// 安全约定（规范 §3.2 / §13）：
//   · 比较必须恒定时间，且不能泄露长度差异；
//   · 界面/日志只出现指纹，永不回显完整 key；
//   · 文件权限 0600，且目录在网站根目录之外。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KEY_PREFIX = 'dshk_';
const ADMIN_PREFIX = 'dshadm_';

export function randomKey(prefix = KEY_PREFIX) {
  // prefix + 43 字符 base64url = 256 bit 熵
  return prefix + crypto.randomBytes(32).toString('base64url');
}

/** 指纹：dshk_AbCdEf…9xYz（规范 §3.2 要求的展示形态） */
export function fingerprint(key) {
  if (typeof key !== 'string' || key.length < 16) return 'dshk_??…??';
  const head = key.slice(0, 10);
  const tail = key.slice(-4);
  return `${head}…${tail}`;
}

/**
 * 恒定时间比较。先把两边哈希成定长摘要再比，
 * 这样既不会因为提前返回泄露前缀，也不会泄露长度。
 */
function secretEquals(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb) || false;
}

export class KeyStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'keys.json');
    this.adminFile = path.join(dataDir, 'admin-key.txt');
    this.entries = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.entries = Array.isArray(raw?.keys) ? raw.keys.filter((e) => e && typeof e.key === 'string') : [];
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[keys] ${this.file} 读取失败：${err.message}`);
      this.entries = [];
    }
    for (const e of this.entries) {
      e.id ||= crypto.randomBytes(6).toString('hex');
      e.createdAt ||= Date.now();
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ keys: this.entries }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* 忽略 */ }
  }

  /** 认证：命中返回条目，否则 null。遍历全部条目做比较，不提前返回。 */
  verify(key) {
    if (typeof key !== 'string' || key.length === 0) return null;
    let hit = null;
    for (const e of this.entries) {
      if (secretEquals(e.key, key)) hit = e;
    }
    if (hit) hit.lastUsedAt = Date.now();
    return hit;
  }

  findByInstanceId(instanceId) {
    return this.entries.find((e) => e.instanceId === instanceId) || null;
  }

  byId(id) {
    return this.entries.find((e) => e.id === id) || null;
  }

  /** 登记（同 key 幂等更新） */
  register(key, { label, instanceId } = {}) {
    if (typeof key !== 'string' || !key.trim()) throw new Error('key 不能为空');
    key = key.trim();
    const existed = this.entries.find((e) => secretEquals(e.key, key));
    if (existed) {
      if (label != null) existed.label = label;
      if (instanceId != null) existed.instanceId = instanceId;
      this.save();
      return existed;
    }
    const entry = {
      id: crypto.randomBytes(6).toString('hex'),
      key,
      label: label || '未命名机器',
      instanceId: instanceId || null,
      createdAt: Date.now(),
      lastUsedAt: null,
      // 用户手工改过名字后置位：此后不再被插件上报的标签覆盖
      renamed: false,
    };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  /**
   * 编辑一条已登记的 key：改备注名 / 换 key / 绑定的 instanceId。
   *
   * 换 key 不会去动机器上的 dsh——它只是把服务器侧记录的 key 换成新的，
   * 所以新值必须是机器当前实际持有的那把，否则下次重连会被拒。
   * 想「服务器和机器同时换」请走 instance.rotateKey 那条路。
   *
   * @param {string} id 条目 id
   * @param {{label?: string, key?: string, instanceId?: string|null}} patch
   * @returns {object|null} 更新后的条目；找不到返回 null
   * @throws {Error} 新 key 与另一条已登记项冲突时抛出
   */
  update(id, patch = {}) {
    const entry = this.byId(id);
    if (!entry) return null;

    if (typeof patch.label === 'string') {
      const label = patch.label.trim();
      if (label) {
        entry.label = label;
        // 用户改过名字之后，重连时不再被插件报上来的标签覆盖
        entry.renamed = true;
      }
    }
    if (typeof patch.key === 'string' && patch.key.trim()) {
      const next = patch.key.trim();
      if (!next.startsWith(KEY_PREFIX)) throw new Error(`key 必须以 ${KEY_PREFIX} 开头`);
      const clash = this.entries.find((e) => e.id !== id && secretEquals(e.key, next));
      if (clash) throw new Error(`这把 key 已经登记在「${clash.label}」上了`);
      entry.key = next;
    }
    if (patch.instanceId !== undefined) {
      entry.instanceId = patch.instanceId === '' ? null : patch.instanceId;
    }
    this.save();
    return entry;
  }

  revoke(id) {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return null;
    const [gone] = this.entries.splice(i, 1);
    this.save();
    return gone;
  }

  /** 只返回脱敏视图 */
  list() {
    return this.entries.map((e) => ({
      id: e.id,
      label: e.label,
      instanceId: e.instanceId,
      fingerprint: fingerprint(e.key),
      createdAt: e.createdAt,
      lastUsedAt: e.lastUsedAt,
      renamed: e.renamed === true,
    }));
  }

  /** 管理密钥：首次运行生成并写入 admin-key.txt（0600） */
  adminKey() {
    try {
      const existing = fs.readFileSync(this.adminFile, 'utf8').trim();
      if (existing) return existing;
    } catch { /* 不存在则生成 */ }
    const created = randomKey(ADMIN_PREFIX);
    fs.mkdirSync(path.dirname(this.adminFile), { recursive: true });
    fs.writeFileSync(this.adminFile, created + '\n', { mode: 0o600 });
    try { fs.chmodSync(this.adminFile, 0o600); } catch { /* 忽略 */ }
    return created;
  }

  adminKeyMatches(candidate) {
    if (!candidate) return false;
    return secretEquals(this.adminKey(), candidate);
  }
}
