import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupWebsocket } from '../../backend/api/websocket.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('websocket', () => {
  let mockWss: { on: any; _handlers: Map<string, any> };
  let connectionCallback: (ws: any) => void;
  let mockWs: { on: any; send: any; _handlers: Map<string, any> };

  beforeEach(() => {
    mockWs = {
      on: function(event: string, cb: any) {
        this._handlers.set(event, cb);
        return this;
      },
      send: function() {},
      _handlers: new Map(),
    };
    
    mockWss = {
      on: function(event: string, cb: any) {
        if (event === 'connection') connectionCallback = cb;
        return this;
      },
      _handlers: new Map(),
    };
  });

  test('setupWebsocket registers connection handler', () => {
    setupWebsocket(mockWss as any);
    assert.strictEqual(typeof connectionCallback, 'function');
  });

  test('should handle ping message with pong response', () => {
    let sentMessage: string | undefined;
    mockWs.send = (msg: string) => { sentMessage = msg; };
    
    setupWebsocket(mockWss as any);
    connectionCallback(mockWs as any);
    
    mockWs._handlers.get('message')!(JSON.stringify({ type: 'ping' }));
    
    assert.ok(sentMessage);
    assert.strictEqual(JSON.parse(sentMessage!).type, 'pong');
  });

  test('should handle unknown message types gracefully', () => {
    let sentMessage: string | undefined;
    mockWs.send = (msg: string) => { sentMessage = msg; };

    setupWebsocket(mockWss as any);
    connectionCallback(mockWs as any);

    mockWs._handlers.get('message')!(JSON.stringify({ type: 'unknown' }));

    assert.strictEqual(sentMessage, undefined);
  });

  test('should handle invalid JSON gracefully', () => {
    let sentMessage: string | undefined;
    mockWs.send = (msg: string) => { sentMessage = msg; };

    setupWebsocket(mockWss as any);
    connectionCallback(mockWs as any);

    // Send invalid JSON
    mockWs._handlers.get('message')!('invalid json');

    assert.strictEqual(sentMessage, undefined);
  });

  test('should handle malformed message objects gracefully', () => {
    let sentMessage: string | undefined;
    mockWs.send = (msg: string) => { sentMessage = msg; };

    setupWebsocket(mockWss as any);
    connectionCallback(mockWs as any);

    // Send valid JSON but malformed message
    mockWs._handlers.get('message')!(JSON.stringify({ notType: 'ping' }));

    assert.strictEqual(sentMessage, undefined);
  });
});