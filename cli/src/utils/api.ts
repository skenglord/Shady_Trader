// cli/src/utils/api.ts — thin HTTP client for the running bot.
const BASE = process.env.BOT_URL || 'http://localhost:3000';
const TOKEN = process.env.API_ADMIN_TOKEN || process.env.API_AUTH_TOKEN || '';

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) h['x-api-token'] = TOKEN;
  return h;
}

export async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${BASE}/api${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

export async function apiPost(path: string, body: any = {}): Promise<any> {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json();
}

export const BOT_BASE = BASE;
