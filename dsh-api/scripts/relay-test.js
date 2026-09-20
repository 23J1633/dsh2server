import assert from 'node:assert/strict';
import test from 'node:test';

import { Relay } from '../lib/relay.js';

test('an authenticated ping refreshes both link and instance liveness', () => {
  const relay = new Relay({ offlineAfterMs: 90000 }, {});
  let linkSeen = 0;
  let instanceSeen = 0;
  let reply = null;

  relay.instances.set('dsh-heartbeat-test', {
    markSeen() { instanceSeen += 1; },
  });

  const link = {
    instanceId: 'dsh-heartbeat-test',
    noteInbound() { linkSeen += 1; },
    send(frame) { reply = frame; return true; },
  };

  try {
    const result = relay.handleInbound(link, { v: 1, type: 'ping', ts: 123 });
    assert.deepEqual(result, { ok: true });
    assert.equal(linkSeen, 1);
    assert.equal(instanceSeen, 1);
    assert.equal(reply?.type, 'pong');
    assert.equal(reply?.v, 1);
  } finally {
    clearInterval(relay.timer);
  }
});
