// Server-side session archive registry.
//
// Archiving here only controls what this relay's console displays. Session
// logs remain on the host unless the caller also asks the DSH plugin to archive
// the session in the host workspace registry.
import fs from 'node:fs';
import path from 'node:path';

export class ArchiveStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'archives.json');
    this.instances = new Map();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [instanceId, rows] of Object.entries(raw?.instances || {})) {
        if (!Array.isArray(rows)) continue;
        const clean = rows.filter((row) => row && typeof row.sessionId === 'string');
        if (clean.length) this.instances.set(instanceId, clean);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`[archives] ${this.file} 读取失败：${error.message}`);
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    const instances = Object.fromEntries(this.instances);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, instances }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows has no POSIX mode bits. */ }
  }

  list(instanceId) {
    return (this.instances.get(instanceId) || []).map((row) => ({ ...row }));
  }

  ids(instanceId) {
    return new Set(this.list(instanceId).map((row) => row.sessionId));
  }

  has(instanceId, sessionId) {
    return (this.instances.get(instanceId) || []).some((row) => row.sessionId === sessionId);
  }

  archive(instanceId, session, scope = 'server') {
    if (typeof instanceId !== 'string' || !instanceId) throw new Error('instanceId 不能为空');
    if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error('sessionId 不能为空');
    const rows = this.instances.get(instanceId) || [];
    const next = {
      sessionId: session.sessionId,
      title: typeof session.title === 'string' ? session.title : null,
      cwd: typeof session.cwd === 'string' ? session.cwd : null,
      scope: scope === 'host' ? 'host' : 'server',
      archivedAt: Date.now(),
    };
    const index = rows.findIndex((row) => row.sessionId === next.sessionId);
    if (index >= 0) rows[index] = { ...rows[index], ...next };
    else rows.push(next);
    this.instances.set(instanceId, rows);
    this.save();
    return { ...next };
  }

  restore(instanceId, sessionId) {
    const rows = this.instances.get(instanceId) || [];
    const next = rows.filter((row) => row.sessionId !== sessionId);
    if (next.length === rows.length) return false;
    if (next.length) this.instances.set(instanceId, next);
    else this.instances.delete(instanceId);
    this.save();
    return true;
  }
}
