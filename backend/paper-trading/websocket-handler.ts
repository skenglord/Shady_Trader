import { WebSocketServer, WebSocket } from 'ws';
import { PaperTradingService } from '../paper-trading/paper-trading-service';
import { logger } from '../logging/logger.js';

export interface PaperTradingWebSocketMessage {
  type: 
    | 'subscribe_paper_positions'
    | 'subscribe_paper_pnl'
    | 'subscribe_paper_prices'
    | 'paper_position_update'
    | 'paper_pnl_update'
    | 'paper_price_update'
    | 'paper_order_fill'
    | 'paper_error';
  data: any;
  timestamp: number;
}

export class PaperTradingWebSocketHandler {
  private clients: Map<string, WebSocket> = new Map();
  private paperTradingService: PaperTradingService;
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly UPDATE_INTERVAL = 100; // 100ms = 10 updates per second

  constructor(paperTradingService: PaperTradingService) {
    this.paperTradingService = paperTradingService;
  }

  public handleConnection(ws: WebSocket, clientId: string): void {
    this.clients.set(clientId, ws);
    
    logger.info('Paper trading WebSocket client connected', { 
      clientId,
      totalClients: this.clients.size 
    });

    // Send initial data
    this.sendInitialData(clientId).catch(error => {
      logger.error('Failed to send initial data', { clientId, error });
    });

    ws.on('message', (message: string) => {
      try {
        const data = JSON.parse(message);
        this.handleMessage(clientId, data);
      } catch (error) {
        logger.error('Failed to parse WebSocket message', { clientId, error });
        this.sendError(clientId, 'Invalid message format');
      }
    });

    ws.on('close', () => {
      this.clients.delete(clientId);
      logger.info('Paper trading WebSocket client disconnected', { 
        clientId,
        totalClients: this.clients.size 
      });

      // Stop updates if no clients left
      if (this.clients.size === 0) {
        this.stopUpdates();
      }
    });

    ws.on('error', (error) => {
      logger.error('Paper trading WebSocket error', { clientId, error });
      this.clients.delete(clientId);
    });

    // Start sending updates if this is the first client
    if (this.clients.size === 1) {
      this.startUpdates();
    }
  }

  private async sendInitialData(clientId: string): Promise<void> {
    const ws = this.clients.get(clientId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      // Send initial positions
      const positions = await this.paperTradingService.getOpenPositions();
      this.sendMessage(clientId, {
        type: 'paper_position_update',
        data: { positions },
        timestamp: Date.now(),
      });

      // Send initial P&L
      const summary = await this.paperTradingService.getSummary();
      this.sendMessage(clientId, {
        type: 'paper_pnl_update',
        data: {
          totalUnrealizedPnl: summary.totalUnrealizedPnl,
          totalRealizedPnl: summary.totalRealizedPnl,
          positionCount: summary.positionCount,
        },
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('Failed to send initial data', { clientId, error });
    }
  }

  private handleMessage(clientId: string, message: any): void {
    switch (message.type) {
      case 'subscribe_paper_positions':
        this.sendMessage(clientId, {
          type: 'paper_position_update',
          data: { subscribed: true, channel: 'positions' },
          timestamp: Date.now(),
        });
        break;

      case 'subscribe_paper_pnl':
        this.sendMessage(clientId, {
          type: 'paper_pnl_update',
          data: { subscribed: true, channel: 'pnl' },
          timestamp: Date.now(),
        });
        break;

      case 'subscribe_paper_prices':
        this.sendMessage(clientId, {
          type: 'paper_price_update',
          data: { subscribed: true, channel: 'prices' },
          timestamp: Date.now(),
        });
        break;

      default:
        this.sendError(clientId, 'Unknown message type');
    }
  }

  private sendMessage(clientId: string, message: PaperTradingWebSocketMessage): void {
    const ws = this.clients.get(clientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        logger.error('Failed to send WebSocket message', { clientId, error });
      }
    }
  }

  private sendError(clientId: string, error: string): void {
    this.sendMessage(clientId, {
      type: 'paper_error',
      data: { error },
      timestamp: Date.now(),
    });
  }

  private startUpdates(): void {
    if (this.updateInterval) {
      return;
    }

    logger.info('Starting paper trading WebSocket updates', {
      interval: this.UPDATE_INTERVAL,
    });

    this.updateInterval = setInterval(() => {
      this.broadcastPositionUpdates().catch(error => {
        logger.error('Failed to broadcast position updates', { error });
      });
      this.broadcastPnlUpdates().catch(error => {
        logger.error('Failed to broadcast P&L updates', { error });
      });
    }, this.UPDATE_INTERVAL);
  }

  public stopUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      logger.info('Stopped paper trading WebSocket updates');
    }
  }

  private async broadcastPositionUpdates(): Promise<void> {
    try {
      const positions = await this.paperTradingService.getOpenPositions();
      
      const message: PaperTradingWebSocketMessage = {
        type: 'paper_position_update',
        data: { positions },
        timestamp: Date.now(),
      };

      this.broadcast(message);
    } catch (error) {
      logger.error('Failed to broadcast position updates', { error });
    }
  }

  private async broadcastPnlUpdates(): Promise<void> {
    try {
      const summary = await this.paperTradingService.getSummary();
      
      const message: PaperTradingWebSocketMessage = {
        type: 'paper_pnl_update',
        data: {
          totalUnrealizedPnl: summary.totalUnrealizedPnl,
          totalRealizedPnl: summary.totalRealizedPnl,
          positionCount: summary.positionCount,
        },
        timestamp: Date.now(),
      };

      this.broadcast(message);
    } catch (error) {
      logger.error('Failed to broadcast P&L updates', { error });
    }
  }

  private broadcast(message: PaperTradingWebSocketMessage): void {
    const deadClients: string[] = [];

    for (const [clientId, ws] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(message));
        } catch (error) {
          logger.error('Failed to broadcast to client', { clientId, error });
          deadClients.push(clientId);
        }
      } else {
        deadClients.push(clientId);
      }
    }

    // Clean up dead clients
    for (const clientId of deadClients) {
      this.clients.delete(clientId);
    }
  }

  public getClientCount(): number {
    return this.clients.size;
  }
}
