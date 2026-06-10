import fs from 'fs';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  // Also load .env.development.local (Vite's loadEnv only reads it in dev mode).
  // The dev-local file is where the test/auth tokens actually live.
  const devLocalPath = path.resolve('.env.development.local');
  let devLocal: Record<string, string> = {};
  if (fs.existsSync(devLocalPath)) {
    for (const line of fs.readFileSync(devLocalPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) devLocal[m[1]] = m[2];
    }
  }
  const adminToken = env.VITE_ADMIN_TOKEN || devLocal.VITE_ADMIN_TOKEN || process.env.API_ADMIN_TOKEN || '';
  const traderToken = env.VITE_TRADER_TOKEN || devLocal.VITE_TRADER_TOKEN || process.env.API_TRADER_TOKEN || '';
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.APP_URL': JSON.stringify(env.APP_URL || ''),
      // Inject auth tokens so the client-side fetch handlers can attach
      // `x-api-token` headers. Without these, every API call returns 401
      // and the dashboard shows no data.
      'import.meta.env.VITE_ADMIN_TOKEN': JSON.stringify(adminToken),
      'import.meta.env.VITE_TRADER_TOKEN': JSON.stringify(traderToken),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
