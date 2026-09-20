import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { defaultA2SConfigFile, readA2SConfig, withA2SDefaults } from '../lib/a2s-shared-config.js'

test('A2S shared config supplies the unified DSH device identity and endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh2server-a2s-'))
  const file = join(directory, 'config.json')
  const document = {
    version: 1,
    device: { id: 'device-1', name: 'test workstation', key: `a2sk_${'x'.repeat(43)}` },
    server: { endpoints: ['https://relay.example/a2s-api'] },
    agents: { dsh: { instanceId: 'device-1:dsh', locale: 'en-US' } },
  }
  try {
    await writeFile(file, JSON.stringify(document), 'utf8')
    const shared = readA2SConfig(file)
    const config = withA2SDefaults({ endpoint: '', key: '', instanceId: '', locale: 'system' }, shared, {})
    assert.deepEqual(config.endpoint, document.server.endpoints)
    assert.equal(config.key, document.device.key)
    assert.equal(config.instanceId, 'device-1:dsh')
    assert.equal(config.deviceId, 'device-1')
    assert.equal(config.displayName, 'test workstation')
    assert.equal(config.locale, 'en-US')
    assert.equal(config.a2sConfigFile, file)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('explicit DSH settings and environment variables retain precedence over A2S defaults', () => {
  const shared = {
    file: 'shared.json',
    document: {
      device: { id: 'device-1', name: 'shared', key: `a2sk_${'x'.repeat(43)}` },
      server: { endpoints: ['https://shared.example/a2s-api'] },
      agents: { dsh: { instanceId: 'device-1:dsh', locale: 'en-US' } },
    },
  }
  const explicit = withA2SDefaults({
    endpoint: 'https://profile.example/dsh-api',
    key: `dshk_${'y'.repeat(43)}`,
    instanceId: 'profile-dsh',
    displayName: 'profile',
    locale: 'zh-CN',
  }, shared, { DSH2SERVER_ENDPOINT: 'https://env.example/dsh-api', DSH2SERVER_KEY: `dshk_${'z'.repeat(43)}` })
  assert.equal(explicit.endpoint, 'https://profile.example/dsh-api')
  assert.equal(explicit.key, `dshk_${'y'.repeat(43)}`)
  assert.equal(explicit.instanceId, 'profile-dsh')
  assert.equal(explicit.displayName, 'profile')
  assert.equal(explicit.locale, 'zh-CN')
  assert.equal(explicit.deviceId, 'device-1')

  assert.equal(defaultA2SConfigFile({ A2S_CONFIG_PATH: 'C:\\portable\\a2s.json' }, 'win32'), 'C:\\portable\\a2s.json')
})
