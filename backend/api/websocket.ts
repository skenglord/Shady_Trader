import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logging/logger.js';

/**
 * WS_AUTH_TIMEOUT_MS — how long (ms) the server waits for the client's first
 * auth message before closing the socket. Configurable via env, default 5s.
 */
const WS_AUTH_TIMEOUT_MS = Number(process.env.WS_AUTH_TIMEOUT_MS ?? 5000);

/** WebSocket close code for "auth required / failed". */
const WS_CLOSE_AUTH = 4401;

/**
 * Token validator shared with server.ts. The function is stashed on the
 * WebSocketServer instance by server.ts (see `(wss as any).getWsAuthTokens`).
 * If it is missing, we fall back to reading the env vars directly.
 */
function resolveGetWsAuthTokens(wss: WebSocketServer): () => { adminToken: string; traderToken: string } {
  const fn = (wss as any).getWsAuthTokens as (() => { adminToken: string; traderToken: string }) | undefined;
  if (fn) return fn;
  // Fallback — keep the same source-of-truth as server.ts
  return () => ({
    adminToken: process.env.API_ADMIN_TOKEN || process.env.API_AUTH_TOKEN || '',
    traderToken: process.env.API_TRADER_TOKEN || '',
  });
}

/**
 * Authenticate a pending WebSocket connection using the first-message protocol.
 *
 * Protocol:
 *   client → server : {"type":"auth","token":"<value>"}   (must be first message)
 *   server → client : {"type":"auth_ok","role":"admin"|"trader"}
 *   server → client : (close 4401) on invalid token / timeout / no tokens configured
 *
 * Post-auth the socket behaves exactly as before (ping → pong, role-tagged
 * broadcasts). No broadcast may be sent to a socket before `authed === true`.
 */
export function setupWebsocket(wss: WebSocketServer) {
  const getWsAuthTokens = resolveGetWsAuthTokens(wss);

  wss.on('connection', (ws: WebSocket, _request: any) => {
    // ── Pending state: NOT yet authenticated ──
    (ws as any).authed = false;
    (ws as any).role = undefined;

    // Start auth timeout. If the client doesn't send a valid auth message
    // within WS_AUTH_TIMEOUT_MS, close the socket.
    const authTimer = setTimeout(() => {
      if (!(ws as any).authed) {
        logger.warn('WebSocket auth timeout — closing', { service: 'websocket' });
        try {
          ws.close(WS_CLOSE_AUTH, 'Auth timeout');
        } catch { /* socket may already be closed */ }
      }
    }, WS_AUTH_TIMEOUT_MS);

    ws.on('message', (message: string) => {
      // ── Pre-auth: only accept the auth message ──
      if (!(ws as any).authed) {
        let data: any;
        try {
          data = JSON.parse(message);
        } catch {
          logger.warn('Invalid JSON before auth — closing', { service: 'websocket' });
          clearTimeout(authTimer);
          ws.close(WS_CLOSE_AUTH, 'Invalid message');
          return;
        }

        if (data.type !== 'auth' || typeof data.token !== 'string') {
          logger.warn('First message is not auth — closing', { service: 'websocket' });
          clearTimeout(authTimer);
          ws.close(WS_CLOSE_AUTH, 'Auth required');
          return;
        }

        const { adminToken, traderToken } = getWsAuthTokens();
        if (!adminToken && !traderToken) {
          // Fail-closed: no tokens configured server-side
          logger.warn('WebSocket auth rejected: tokens not configured server-side', { service: 'websocket' });
          clearTimeout(authTimer);
          ws.close(WS_CLOSE_AUTH, 'Auth not configured');
          return;
        }

        let role: 'admin' | 'trader' | null = null;
        if (adminToken && data.token === adminToken) role = 'admin';
        else if (traderToken && data.token === traderToken) role = 'trader';

        if (!role) {
          logger.warn('WebSocket auth rejected: invalid token', { service: 'websocket' });
          clearTimeout(authTimer);
          ws.close(WS_CLOSE_AUTH, 'Unauthorized');
          return;
        }

        // ── Auth success ──
        clearTimeout(authTimer);
        (ws as any).authed = true;
        (ws as any).role = role;
        logger.debug('Client authenticated', { service: 'websocket', role });
        ws.send(JSON.stringify({ type: 'auth_ok', role }));
        return;
      }

      // ── Post-auth: normal message handling ──
      try {
        const data = JSON.parse(message);
        logger.debug('Received message', { data, service: 'websocket' });

        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (error: any) {
        logger.error('Error parsing message', { error: String(error), service: 'websocket' });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      logger.debug('Client disconnected', { service: 'websocket', authed: (ws as any).authed });
    });
  });
}
