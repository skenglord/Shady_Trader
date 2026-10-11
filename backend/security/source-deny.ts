import type { RequestHandler } from 'express';

const deniedPrefixes = [
  '/backend/', '/cli/', '/scripts/', '/src/backend/', '/coverage/',
  '/test-results/', '/playwright-report/', '/backups/', '/logs/', '/uploads/',
  '/data/', '/.git/', '/.kilo/', '/.hermes/', '/node_modules/typescript/',
  '/node_modules/.bin/', '/node_modules/.cache/', '/tests/', '/docs/',
  '/documentation/', '/k8s/', '/docker/', '/qa-output',
];

const deniedExact = new Set([
  '/package.json', '/package-lock.json', '/tsconfig.json', '/tsconfig.node.json',
  '/vite.config.ts', '/server.ts', '/server-clean.log', '/server-clean2.log',
  '/server-final.log', '/server.pid', '/seed.ts', '/.env', '/.env.example',
  '/.env.development.local', '/.env.production', '/playwright.config.ts',
  '/.gitignore', '/.dockerignore', '/AGENTS.md', '/CLAUDE.md', '/CHANGES.md',
  '/CODEBASE_STRUCTURE.md', '/SYSTEM_DATA_ANALYSIS.md', '/test_audit_report.md',
  '/build_logic.md', '/README.md', '/COMPONENT_READINESS_MATRIX.md',
  '/cli-smoke-output.txt', '/docker-compose.yml', '/Dockerfile', '/test-db.js',
  '/helm.tar.gz', '/Bitcoin Historical Data.html', '/comparecryptoapi.pdf',
  '/metadata.json', '/highlights.json',
]);

function canonicalPath(rawPath: string): string | null {
  let value = rawPath;
  try {
    // Decode repeatedly so double-encoded traversal and protected paths are denied.
    for (let i = 0; i < 4; i++) {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    }
  } catch { return null; }
  if (value.includes('\\') || value.split('/').some(part => part === '..')) return null;
  return value.replace(/\/{2,}/g, '/');
}

export function createSourceDenyMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = canonicalPath(req.path);
    if (!p || p === '/@fs' || p.startsWith('/@fs/')) return res.status(404).json({ error: 'Not Found' });
    if (deniedExact.has(p)) return res.status(404).json({ error: 'Not Found' });
    if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(p)) return res.status(404).json({ error: 'Not Found' });
    for (const prefix of deniedPrefixes) {
      if (p === prefix.slice(0, -1) || p.startsWith(prefix)) return res.status(404).json({ error: 'Not Found' });
    }
    next();
  };
}
