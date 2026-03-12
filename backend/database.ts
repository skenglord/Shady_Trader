import { Worker } from 'worker_threads';
import path from 'path';

let worker: Worker;
let messageId = 0;
const pendingRequests = new Map<number, { resolve: Function; reject: Function }>();

export function initDatabase() {
  worker = new Worker(path.join(process.cwd(), 'backend/database_worker.js'));
  worker.on('message', (message) => {
    const { id, result, error } = message;
    const request = pendingRequests.get(id);
    if (request) {
      if (error) request.reject(new Error(error));
      else request.resolve(result);
      pendingRequests.delete(id);
    }
  });
}

let mockRunQuery: ((sql: string, params: any[], type: 'run' | 'all') => Promise<any>) | null = null;

export function setMockRunQuery(fn: typeof mockRunQuery) {
  mockRunQuery = fn;
}

export async function runQuery(sql: string, params: any[] = [], type: 'run' | 'all' = 'run'): Promise<any> {
  if (mockRunQuery) return mockRunQuery(sql, params, type);
  return new Promise((resolve, reject) => {
    const id = messageId++;
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage({ id, sql, params, type });
  });
}
