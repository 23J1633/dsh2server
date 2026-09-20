import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ArchiveStore } from '../dsh-api/lib/archive-store.js'

test('relay archive store persists per-instance visibility without touching host data', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-archives-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const first = new ArchiveStore(dir)
  first.archive('machine-a', { sessionId: 'session-a', title: 'A', cwd: 'C:/work' }, 'server')
  first.archive('machine-a', { sessionId: 'session-b', title: 'B' }, 'host')
  first.archive('machine-b', { sessionId: 'session-a', title: 'other machine' }, 'server')

  const reopened = new ArchiveStore(dir)
  assert.deepEqual([...reopened.ids('machine-a')], ['session-a', 'session-b'])
  assert.equal(reopened.list('machine-a')[1].scope, 'host')
  assert.deepEqual([...reopened.ids('machine-b')], ['session-a'])
  assert.equal(reopened.restore('machine-a', 'session-a'), true)
  assert.equal(reopened.has('machine-a', 'session-a'), false)
  assert.equal(reopened.has('machine-b', 'session-a'), true)
})
