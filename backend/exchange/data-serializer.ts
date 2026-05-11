import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let root: protobuf.Root;

export async function initProtobuf() {
  root = await protobuf.load(path.join(__dirname, 'marketdata.proto'));
}

export function encodeCandle(candle: any): Buffer {
  const CandleMessage = root.lookupType('marketdata.Candle');
  const message = CandleMessage.create(candle);
  return Buffer.from(CandleMessage.encode(message).finish());
}

export function decodeCandle(buffer: Buffer): any {
  const CandleMessage = root.lookupType('marketdata.Candle');
  return CandleMessage.decode(buffer);
}

export function encodeTrade(trade: any): Buffer {
  const TradeMessage = root.lookupType('marketdata.Trade');
  const message = TradeMessage.create(trade);
  return Buffer.from(TradeMessage.encode(message).finish());
}

export function decodeTrade(buffer: Buffer): any {
  const TradeMessage = root.lookupType('marketdata.Trade');
  return TradeMessage.decode(buffer);
}

export function encodeOrderBook(orderBook: any): Buffer {
  const OrderBookMessage = root.lookupType('marketdata.OrderBook');
  const message = OrderBookMessage.create(orderBook);
  return Buffer.from(OrderBookMessage.encode(message).finish());
}

export function decodeOrderBook(buffer: Buffer): any {
  const OrderBookMessage = root.lookupType('marketdata.OrderBook');
  return OrderBookMessage.decode(buffer);
}

export function encodeMarketDataBatch(batch: any): Buffer {
  const BatchMessage = root.lookupType('marketdata.MarketDataBatch');
  const message = BatchMessage.create(batch);
  return Buffer.from(BatchMessage.encode(message).finish());
}

export function decodeMarketDataBatch(buffer: Buffer): any {
  const BatchMessage = root.lookupType('marketdata.MarketDataBatch');
  return BatchMessage.decode(buffer);
}

// Zero-copy buffer operations for high performance
export class ZeroCopyBuffer {
  private buffer: Buffer;
  private offset: number;

  constructor(size: number = 65536) { // 64KB default
    this.buffer = Buffer.allocUnsafe(size);
    this.offset = 0;
  }

  write(data: Buffer): boolean {
    if (this.offset + data.length > this.buffer.length) {
      return false; // Buffer full
    }

    data.copy(this.buffer, this.offset);
    this.offset += data.length;
    return true;
  }

  read(length: number): Buffer | null {
    if (this.offset < length) {
      return null; // Not enough data
    }

    const data = this.buffer.subarray(0, length);
    this.buffer.copyWithin(0, length, this.offset);
    this.offset -= length;
    return data;
  }

  getAvailableSpace(): number {
    return this.buffer.length - this.offset;
  }

  reset() {
    this.offset = 0;
  }

  resize(newSize: number) {
    const newBuffer = Buffer.allocUnsafe(newSize);
    this.buffer.copy(newBuffer, 0, 0, Math.min(this.offset, newSize));
    this.buffer = newBuffer;
  }
}