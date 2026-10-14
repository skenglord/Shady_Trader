export async function waitForLocalReadiness(url, child, options = {}) {
  const fetchResponse = options.fetch || globalThis.fetch;
  const pause = options.pause || (() => new Promise(resolve => setTimeout(resolve, 500)));
  for (let attempt = 0; attempt < (options.attempts || 60); attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('App server exited before readiness');
    try {
      const response = await fetchResponse(`${url}/api/health/ready`, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
      if (response.ok && (await response.json()).status === 'ready') return;
    } catch { /* Retry while the database and engine initialize. */ }
    await pause();
  }
  throw new Error(`App did not become ready at ${url}`);
}
