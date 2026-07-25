/**
 * useTradingWebSocket — WebSocket lifecycle hook.
 *
 * Extracted from the inline WS logic in App() (originally lines ~398-505).
 *
 * Connects to the WS endpoint derived from window.location, sends the T3 auth
 * handshake ({type:'auth', token:getTraderToken()}) as the first message, and
 * dispatches incoming messages to typed callbacks. Reconnect logic is driven by
 * connectionStore (max 5 attempts with exponential backoff).
 *
 * Returns connection state (isDataPassing) plus a lastMessageTime ref so the
 * caller can implement the 15s staleness check from the original polling interval.
 */
import { useEffect, useRef } from 'react';
import { getTraderToken } from '../auth/tokenStore';
import { useConnectionStore } from '../stores/connectionStore';
import { debug } from '../api/client';

export interface WsMessageCallbacks {
  onStatus?: (data: any) => void;
  onRegime?: (data: any) => void;
  onPerformance?: (data: any) => void;
  onCandle?: (data: any) => void;
  onSignal?: () => void;
  onAiModeSwitch?: (mode: string) => void;
  onBalances?: (data: any) => void;
  onSignalStatus?: (data: any) => void;
  onSignalRecord?: (data: any) => void;
}

export interface UseTradingWebSocketResult {
  isDataPassing: boolean;
  lastMessageTimeRef: React.MutableRefObject<number>;
  wsRef: React.MutableRefObject<WebSocket | null>;
}

export function useTradingWebSocket(callbacks: WsMessageCallbacks): UseTradingWebSocketResult {
  const wsRef = useRef<WebSocket | null>(null);
  const lastMessageTimeRef = useRef(0);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const isDataPassing = useConnectionStore((s) => s.isDataPassing);

  // Keep latest callbacks without re-running the WS effect
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;

    const connect = () => {
      if (!mounted) return;
      const wsBase = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
      const ws = new WebSocket(wsBase);
      const store = useConnectionStore.getState();
      store.setConnectionStatus('connecting');

      // Connection timeout — prevent hanging forever (5s, same as original)
      const wsTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          debug.warn('WebSocket connection timeout, continuing without WS');
          ws.close();
        }
      }, 5000);

      ws.onopen = () => {
        clearTimeout(wsTimeout);
        debug.log('WebSocket connected');
        const s = useConnectionStore.getState();
        s.setConnectionStatus('connected');
        s.resetReconnectAttempts();
        // T3: send the auth handshake as the first message after connect.
        // The server will close the socket (4401) if this is not received
        // within WS_AUTH_TIMEOUT_MS.
        const token = getTraderToken();
        if (token) {
          ws.send(JSON.stringify({ type: 'auth', token }));
        } else {
          debug.warn('No trader token available for WS auth — connection will be rejected by server');
        }
      };

      ws.onerror = (error) => {
        clearTimeout(wsTimeout);
        debug.warn('WebSocket error:', error);
      };

      ws.onclose = () => {
        clearTimeout(wsTimeout);
        const s = useConnectionStore.getState();
        s.setConnectionStatus('disconnected');
        // Reconnect with exponential backoff via connectionStore (max 5 attempts)
        if (s.reconnectAttempts < s.maxReconnectAttempts && mounted) {
          s.incrementReconnectAttempts();
          const delay = Math.min(1000 * Math.pow(2, s.reconnectAttempts), 30000);
          s.setConnectionStatus('connecting');
          debug.log(`WebSocket reconnecting in ${delay}ms (attempt ${s.reconnectAttempts}/${s.maxReconnectAttempts})`);
          reconnectTimer = setTimeout(connect, delay);
        }
      };

      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          lastMessageTimeRef.current = Date.now();
          const s = useConnectionStore.getState();
          s.setDataPassing(true);
          s.updateLastCallTime(Date.now());
          const data = JSON.parse(event.data);
          const cb = callbacksRef.current;

          // T3: handle the auth confirmation message (no-op, just acknowledge)
          if (data.type === 'auth_ok') {
            debug.log(`WebSocket auth confirmed: role=${data.role}`);
            return;
          }
          if (data.type === 'status') {
            cb.onStatus?.(data.data);
          } else if (data.type === 'regime') {
            cb.onRegime?.(data.data);
          } else if (data.type === 'performance') {
            cb.onPerformance?.(data.data);
          } else if (data.type === 'candle') {
            cb.onCandle?.(data.data);
          } else if (data.type === 'signal') {
            cb.onSignal?.();
          } else if (data.type === 'ai_mode_switch') {
            cb.onAiModeSwitch?.(data.data.mode);
          } else if (data.type === 'balances') {
            cb.onBalances?.(data.data);
          } else if (data.type === 'signal_status') {
            cb.onSignalStatus?.(data.data);
          } else if (data.type === 'signal_record') {
            cb.onSignalRecord?.(data.data);
          }
        } catch (err) {
          debug.warn('WebSocket error:', err);
        }
      };
    };

    connect();

    return () => {
      mounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect during cleanup
        wsRef.current.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isDataPassing, lastMessageTimeRef, wsRef };
}
