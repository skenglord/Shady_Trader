import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { setupWebsocket } from '../../backend/api/websocket.js';

// T3 replaced ?token= URL auth with a first-message handshake:
//   client → server : {"type":"auth","token":"<value>"}   (must be first message)
//   server → client : {"type":"auth_ok","role":"admin"|"trader"}
//   server → client : (close 4401) on invalid token / timeout / no tokens configured
// Post-auth, ping → pong is preserved. No broadcast before authed === true.
// These tests exercise the handshake model. getWsAuthTokens() is stashed on the
// mock wss by server.ts in production; here we provide it directly.

const TEST_TOKENS = { adminToken: 'admin-secret', traderToken: 'trader-secret' };

describe('websocket (first-message auth handshake)', () => {
  let mockWss: { on: any; getWsAuthTokens?: () => { adminToken: string; traderToken: string } };
  let connectionCallback: (ws: any, request?: any) => void;
  let mockWs: { on: any; send: any; close: any; _handlers: Map<string, any>; authed?: boolean; role?: string };

  beforeEach(() => {
    mockWs = {
      on: function(event: string, cb: any) {
        this._handlers.set(event, cb);
        return this;
      },
      send: function() {},
      close: function() {},
      _handlers: new Map(),
    };

    mockWss = {
      on: function(event: string, cb: any) {
        if (event === 'connection') connectionCallback = cb;
        return this;
      },
      getWsAuthTokens: () => TEST_TOKENS,
    };
  });

  test('setupWebsocket registers connection handler', () => {
    setupWebsocket(mockWss as any);
    assert.strictEqual(typeof connectionCallback, 'function');
  });

  test('auth handshake: valid trader token → auth_ok with role, then ping → pong', () => {
    const sent: string[] = [];
    mockWs.send = (msg: string) => { sent.push(msg); };

    setupWebsocket(mockWss as any);
    // The connection handler no longer requires wsRole on the request —
    // auth happens via the first message.
    connectionCallback(mockWs as any, {});

    // First message: auth with the trader token.
    mockWs._handlers.get('message')!(JSON.stringify({ type: 'auth', token: 'trader-secret' }));

    const okIdx = sent.findIndex(m => { try { return JSON.parse(m).type === 'auth_ok'; } catch { return false; } });
    assert.notStrictEqual(okIdx, -1, 'expected an auth_ok reply');
    assert.strictEqual(JSON.parse(sent[okIdx]).role, 'trader');
    assert.strictEqual((mockWs as any).authed, true);
    assert.strictEqual((mockWs as any).role, 'trader');

    // Post-auth ping → pong is preserved.
    mockWs._handlers.get('message')!(JSON.stringify({ type: 'ping' }));
    const pongIdx = sent.findIndex(m => { try { return JSON.parse(m).type === 'pong'; } catch { return false; } });
    assert.notStrictEqual(pongIdx, -1, 'expected a pong reply after auth');
  });

  test('auth handshake: valid admin token → auth_ok with role admin', () => {
    const sent: string[] = [];
    mockWs.send = (msg: string) => { sent.push(msg); };

    setupWebsocket(mockWss as any);
    connectionCallback(mockWs as any, {});
    mockWs._handlers.get('message')!(JSON.stringify({ type: 'auth', token: 'admin-secret' }));

    const ok = sent.find(m => { try { return JSON.parse(m).type === 'auth_ok'; } catch { return false; } });
    assert.ok(ok, 'expected an auth_ok reply');
    assert.strictEqual(JSON.parse(ok).role, 'admin');
  });

  test('rejects an invalid token with close 4401', () => {
    let closeCode: number | undefined;
    mockWs.close = (code: number) => { closeCode = code; };

    setupWebsocket(mockWss as any);
    connectionCallback(mockWs as any, {});
    mockWs._handlers.get('message')!(JSON.stringify({ type: 'auth', token: 'wrong' }));

    assert.strictEqual(closeCode, 4401);
    // authed was set to false on connect (pending) and never flipped to true.
    assert.strictEqual((mockWs as any).authed, false);
  });

  test('rejects a non-auth first message with close 4401', () => {
    let closeCode: number | undefined;
    mockWs.close = (code: number) => { closeCode = code; };

    setupWebsocket(mockWss as any);
    connectionCallback(mockWs as any, {});
    // Ping before auth is not allowed.
    mockWs._handlers.get('message')!(JSON.stringify({ type: 'ping' }));

    assert.strictEqual(closeCode, 4401);
  });

  test('rejects invalid JSON before auth with close 4401', () => {
    let closeCode: number | undefined;
    mockWs.close = (code: number) => { closeCode = code; };

    setupWebsocket(mockWss as any);
    connectionCallback(mockWs as any, {});
    mockWs._handlers.get('message')!('not json');

    assert.strictEqual(closeCode, 4401);
  });

  test('handles unknown message types gracefully after auth (no reply)', () => {
    const sent: string[] = [];
    mockWs.send = (msg: string) => { sent.push(msg); };

    setupWebsocket(mockWss as any);
    connectionCallback(mockWs as any, {});
    mockWs._handlers.get('message')!(JSON.stringify({ type: 'auth', token: 'trader-secret' }));
    const before = sent.length;
    mockWs._handlers.get('message')!(JSON.stringify({ type: 'unknown' }));
    // No new message sent for an unknown type.
    assert.strictEqual(sent.length, before);
  });

  test('fail-closed: closes 4401 when no tokens are configured server-side', () => {
    let closeCode: number | undefined;
    mockWs.close = (code: number) => { closeCode = code; };
    mockWss.getWsAuthTokens = () => ({ adminToken: '', traderToken: '' });

    setupWebsocket(mockWss as any);
    connectionCallback(mockWs as any, {});
    mockWs._handlers.get('message')!(JSON.stringify({ type: 'auth', token: 'trader-secret' }));

    assert.strictEqual(closeCode, 4401);
  });
});
