import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logging/logger.js';

export function setupWebsocket(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, request: any) => {
    // Role is set in server.ts verifyClient. If absent, treat as unauthenticated
    // (defense in depth: even if verifyClient is bypassed in some future change,
    // the connection handler rejects clients without a verified role).
    const role = request?.wsRole as 'admin' | 'trader' | undefined;
    if (!role) {
      logger.warn('WebSocket connection without role — closing', { service: 'websocket' });
      ws.close(1008, 'Unauthorized');
      return;
    }
    (ws as any).role = role;
    logger.debug('Client connected', { service: 'websocket', role });

    ws.on('message', (message: string) => {
      try {
        const data = JSON.parse(message);
        logger.debug('Received message', { data, service: 'websocket' });

        // Handle incoming messages if needed
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (error: any) {
        logger.error('Error parsing message', { error: String(error), service: 'websocket' });
      }
    });

    ws.on('close', () => {
      logger.debug('Client disconnected', { service: 'websocket' });
    });
  });
}
