// Monte Carlo WebSocket Handler for Real-Time Progress Updates
import { WebSocket } from 'ws';
import { MonteCarloEngine } from '../engine/monte-carlo-engine';
import { logger } from '../../logging/logger';

export class MonteCarloWebSocketHandler {
  private connections: Map<string, WebSocket>;
  private mcEngine: MonteCarloEngine;

  constructor() {
    this.connections = new Map();
    this.mcEngine = new MonteCarloEngine();
  }

  /**
   * Handle new WebSocket connection
   */
  handleConnection(ws: WebSocket, jobId: string): void {
    logger.info('New Monte Carlo WebSocket connection', { jobId });
    
    this.connections.set(jobId, ws);
    
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        await this.handleMessage(jobId, data, ws);
      } catch (error) {
        logger.error('WebSocket message parse error', {
          jobId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        
        this.sendError(ws, 'Invalid message format');
      }
    });
    
    ws.on('close', () => {
      logger.info('Monte Carlo WebSocket connection closed', { jobId });
      this.connections.delete(jobId);
    });
    
    ws.on('error', (error) => {
      logger.error('Monte Carlo WebSocket error', {
        jobId,
        error: error.message
      });
      this.connections.delete(jobId);
    });
    
    // Send initial status
    this.sendStatus(ws, jobId);
  }

  /**
   * Handle incoming WebSocket messages
   */
  private async handleMessage(
    jobId: string,
    data: any,
    ws: WebSocket
  ): Promise<void> {
    switch (data.type) {
      case 'subscribe':
        await this.handleSubscribe(jobId, ws);
        break;
        
      case 'get_status':
        await this.sendStatus(ws, jobId);
        break;
        
      case 'cancel':
        await this.handleCancel(jobId, ws);
        break;
        
      default:
        this.sendError(ws, 'Unknown message type');
    }
  }

  /**
   * Handle subscription request
   */
  private async handleSubscribe(jobId: string, ws: WebSocket): Promise<void> {
    const status = await this.mcEngine.getStatus(jobId);
    
    if (!status) {
      this.sendError(ws, 'Job not found');
      return;
    }
    
    this.sendStatusUpdate(ws, status);
  }

  /**
   * Handle cancel request
   */
  private async handleCancel(jobId: string, ws: WebSocket): Promise<void> {
    // Note: Actual cancellation would require job tracking
    // For now, just acknowledge
    this.sendStatus(ws, jobId);
  }

  /**
   * Send current status
   */
  private async sendStatus(ws: WebSocket, jobId: string): Promise<void> {
    const status = await this.mcEngine.getStatus(jobId);
    
    if (!status) {
      this.sendError(ws, 'Job not found');
      return;
    }
    
    this.sendStatusUpdate(ws, status);
  }

  /**
   * Send status update to client
   */
  private sendStatusUpdate(ws: WebSocket, status: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      const message = {
        type: 'status_update',
        jobId: status.jobId,
        status: status.status,
        progress: status.progress || 0,
        result: status.result,
        error: status.error,
        timestamp: new Date().toISOString()
      };
      
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send error message
   */
  private sendError(ws: WebSocket, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message,
        timestamp: new Date().toISOString()
      }));
    }
  }

  /**
   * Broadcast progress update to all connected clients
   */
  broadcastProgress(jobId: string, progress: number, partialResult?: any): void {
    const ws = this.connections.get(jobId);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      const message = {
        type: 'progress',
        jobId,
        progress,
        partialResult,
        timestamp: new Date().toISOString()
      };
      
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast completion to all connected clients
   */
  broadcastCompletion(jobId: string, result: any): void {
    const ws = this.connections.get(jobId);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      const message = {
        type: 'completed',
        jobId,
        result,
        timestamp: new Date().toISOString()
      };
      
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Get active connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Close all connections
   */
  closeAll(): void {
    for (const [jobId, ws] of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Server shutting down');
      }
      this.connections.delete(jobId);
    }
  }
}
