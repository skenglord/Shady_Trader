import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForLocalReadiness } from '../../scripts/local-app-readiness.mjs';

test('launcher requires JSON readiness and never accepts the SPA HTML fallback', async () => {
  let calls = 0;
  await waitForLocalReadiness('http://127.0.0.1:3000', { exitCode: null, signalCode: null }, {
    attempts: 2, pause: async () => {},
    fetch: async (url: string) => {
      assert.equal(url, 'http://127.0.0.1:3000/api/health/ready');
      calls++;
      return calls === 1 ? new Response('<html>SPA</html>', { status: 200 }) : Response.json({ status: 'ready' });
    },
  });
  assert.equal(calls, 2);
});

test('launcher rejects a server that never reports ready', async () => {
  await assert.rejects(waitForLocalReadiness('http://local', { exitCode: null, signalCode: null }, {
    attempts: 1, pause: async () => {}, fetch: async () => Response.json({ status: 'not ready' }, { status: 503 }),
  }), /did not become ready/);
});
