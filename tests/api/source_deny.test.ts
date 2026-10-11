import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createSourceDenyMiddleware } from '../../backend/security/source-deny.js';

describe('development source deny middleware', () => {
  test('blocks source aliases, encoded paths, traversal, and local database files', async () => {
    const app = express();
    app.use(createSourceDenyMiddleware());
    app.use((_req, res) => res.status(200).send('served'));
    for (const path of [
      '/backend/main.ts', '/%62ackend/main.ts', '/@fs/home/creekz/Shady_Trader/backend/main.ts?raw',
      '/%2540fs/home/creekz/Shady_Trader/server.ts', '/../../backend/main.ts',
      '/trader.db', '/data/trader.sqlite-wal',
    ]) {
      const result = await request(app).get(path);
      assert.strictEqual(result.status, 404, `${path} should be denied`);
    }
  });

  test('allows ordinary app assets and Vite runtime assets', async () => {
    const app = express();
    app.use(createSourceDenyMiddleware());
    app.use((_req, res) => res.status(200).send('served'));
    assert.strictEqual((await request(app).get('/assets/app.js')).status, 200);
    assert.strictEqual((await request(app).get('/node_modules/.vite/deps/react.js')).status, 200);
  });
});
