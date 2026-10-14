import type { PaperTradingService } from './paper-trading-service.js';

let service: PaperTradingService | null = null;

export function registerPaperTradingService(instance: PaperTradingService | null): void {
  service = instance;
}

export function getPaperTradingService(): PaperTradingService {
  if (!service) throw new Error('Paper trading service is unavailable');
  return service;
}
