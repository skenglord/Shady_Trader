import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../logging/logger.js';

export interface WebSocketConnection {
  id: string;
  ws: WebSocket;
  url: string;
  subscriptions: Set<string>;
  lastHeartbeat: number;
  reconnectAttempts: number;
  isConnected: boolean;
}

export class WebSocketConnectionPool extends EventEmitter {
  private pools: Map<string, WebSocketConnection[]> = new Map();
  private maxConnectionsPerPool = 10;
  private heartbeatInterval = 30000; // 30 seconds
  private reconnectDelay = 5000; // 5 seconds
  private maxReconnectAttempts = 5;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startHeartbeatMonitoring();
  }

  private startHeartbeatMonitoring() {
    this.heartbeatTimer = setInterval(() => {
      this.checkConnectionHealth();
    }, this.heartbeatInterval);
  }

  private checkConnectionHealth() {
    for (const [url, connections] of this.pools) {
      for (const conn of connections) {
        const timeSinceHeartbeat = Date.now() - conn.lastHeartbeat;

        if (timeSinceHeartbeat > this.heartbeatInterval * 2) {
          logger.warn('WebSocket connection stale, attempting reconnect', {
            connectionId: conn.id,
            url: conn.url
          });
          this.reconnectConnection(conn);
        }
      }
    }
  }

  async getConnection(url: string, subscriptionKey?: string): Promise<WebSocketConnection> {
    let pool = this.pools.get(url);
    if (!pool) {
      pool = [];
      this.pools.set(url, pool);
    }

    // Find existing connection with capacity
    let connection = pool.find(conn =>
      conn.isConnected &&
      conn.subscriptions.size < 100 && // Max subscriptions per connection
      (!subscriptionKey || !conn.subscriptions.has(subscriptionKey))
    );

    if (!connection) {
      if (pool.length >= this.maxConnectionsPerPool) {
        // Pool is full, wait for a connection or create new one
        connection = await this.waitForAvailableConnection(url);
      } else {
        // Create new connection
        connection = await this.createConnection(url);
        pool.push(connection);
      }
    }

    if (subscriptionKey) {
      connection.subscriptions.add(subscriptionKey);
    }

    return connection;
  }

  private async waitForAvailableConnection(url: string): Promise<WebSocketConnection> {
    return new Promise((resolve, reject) => {
      const pool = this.pools.get(url)!;
      const checkInterval = setInterval(() => {
        const availableConn = pool.find(conn =>
          conn.isConnected && conn.subscriptions.size < 100
        );

        if (availableConn) {
          clearInterval(checkInterval);
          resolve(availableConn);
        }
      }, 100);

      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Timeout waiting for available WebSocket connection'));
      }, 10000);
    });
  }

  private async createConnection(url: string): Promise<WebSocketConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const connectionId = `${url}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const connection: WebSocketConnection = {
        id: connectionId,
        ws,
        url,
        subscriptions: new Set(),
        lastHeartbeat: Date.now(),
        reconnectAttempts: 0,
        isConnected: false
      };

      ws.on('open', () => {
        connection.isConnected = true;
        connection.lastHeartbeat = Date.now();
        logger.info('WebSocket connection established', {
          connectionId,
          url
        });
        resolve(connection);
      });

      ws.on('message', (data: Buffer) => {
        connection.lastHeartbeat = Date.now();
        this.emit('message', connection, data);
      });

      ws.on('error', (error) => {
        logger.error('WebSocket connection error', {
          connectionId,
          url,
          error: error.message
        });
        connection.isConnected = false;
      });

      ws.on('close', (code, reason) => {
        connection.isConnected = false;
        logger.info('WebSocket connection closed', {
          connectionId,
          url,
          code,
          reason: reason.toString()
        });

        // Attempt reconnect if not intentional close
        if (code !== 1000 && connection.reconnectAttempts < this.maxReconnectAttempts) {
          setTimeout(() => {
            this.reconnectConnection(connection);
          }, this.reconnectDelay * Math.pow(2, connection.reconnectAttempts));
        }
      });

      ws.on('ping', () => {
        connection.lastHeartbeat = Date.now();
        ws.pong();
      });

      // Connection timeout
      setTimeout(() => {
        if (!connection.isConnected) {
          ws.close();
          reject(new Error(`WebSocket connection timeout for ${url}`));
        }
      }, 10000);
    });
  }

  private async reconnectConnection(connection: WebSocketConnection) {
    if (connection.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached, giving up', {
        connectionId: connection.id,
        url: connection.url
      });
      return;
    }

    connection.reconnectAttempts++;
    logger.info('Attempting to reconnect WebSocket', {
      connectionId: connection.id,
      attempt: connection.reconnectAttempts
    });

    try {
      const newConnection = await this.createConnection(connection.url);
      // Transfer subscriptions to new connection
      for (const sub of connection.subscriptions) {
        newConnection.subscriptions.add(sub);
      }

      // Replace in pool
      const pool = this.pools.get(connection.url)!;
      const index = pool.indexOf(connection);
      if (index !== -1) {
        pool[index] = newConnection;
      }

      // Close old connection
      connection.ws.close();
    } catch (error) {
      logger.error('Reconnection failed', {
        connectionId: connection.id,
        error: error.message
      });
    }
  }

  releaseConnection(url: string, connectionId: string, subscriptionKey?: string) {
    const pool = this.pools.get(url);
    if (!pool) return;

    const connection = pool.find(conn => conn.id === connectionId);
    if (!connection) return;

    if (subscriptionKey) {
      connection.subscriptions.delete(subscriptionKey);
    }

    // If no more subscriptions, mark for cleanup
    if (connection.subscriptions.size === 0) {
      logger.info('WebSocket connection released', {
        connectionId,
        url
      });
      // Keep connection alive for potential reuse
    }
  }

  sendMessage(url: string, connectionId: string, message: any) {
    const pool = this.pools.get(url);
    if (!pool) return false;

    const connection = pool.find(conn => conn.id === connectionId);
    if (!connection || !connection.isConnected) return false;

    try {
      connection.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      logger.error('Failed to send WebSocket message', {
        connectionId,
        error: error.message
      });
      return false;
    }
  }

  getPoolStats() {
    const stats: Record<string, any> = {};

    for (const [url, connections] of this.pools) {
      stats[url] = {
        totalConnections: connections.length,
        activeConnections: connections.filter(c => c.isConnected).length,
        totalSubscriptions: connections.reduce((sum, c) => sum + c.subscriptions.size, 0)
      };
    }

    return stats;
  }

  shutdown() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    for (const [url, connections] of this.pools) {
      for (const conn of connections) {
        conn.ws.close(1000, 'Shutdown');
      }
    }

    this.pools.clear();
    logger.info('WebSocket connection pool shut down');
  }
}

// Global instance
export const wsConnectionPool = new WebSocketConnectionPool();