# Production Readiness Todo

Created: 2026-06-10

## Current verified gate state

- `npm run lint`: pass.
- `npm run build`: pass; Vite reports only the existing large-chunk warning.
- `npm test -- --test-reporter=spec --test-concurrency=1`: pass; 397 tests, 396 pass, 0 fail, 1 skipped.
- `npx tsx --test --test-reporter=spec tests/deep-deterministic/deep_deterministic_main.test.ts`: pass; 33 tests, 33 pass, 0 fail, 0 skipped.
- `git diff --check`: pass.
- `npm run quality:coverage`: fail; lines=44.14% (min 50%), branches=73.24% (min 65%).
- `npm run quality:complexity`: fail; `backend/main.ts :: runCycle => 88` and `backend/shadow/shadow_trader.ts :: updatePositions => 51` exceed max 50.
- `npm run security:audit`: fail; `npm audit --omit=dev --audit-level=high` reports 28 vulnerabilities: 4 critical, 21 high, 3 moderate.

## Production-readiness todo

1. **Close the coverage gate**
   - Add focused tests for the lowest-coverage backend areas: database worker, Monte Carlo modules, WFA validation modules, paper-trading websocket handler, exchange connector, ML bridge/retrain paths, and legacy/deprecated files.
   - Re-run `npm run quality:coverage` until line coverage is at least 50% and branch coverage is at least 65%.

2. **Reduce cyclomatic complexity**
   - Refactor `backend/main.ts :: runCycle` from complexity 88 to below 50 by extracting smaller helpers for exchange checks, candle validation, signal generation, trade execution, and state updates.
   - Refactor `backend/shadow/shadow_trader.ts :: updatePositions` from complexity 51 to below 50 by extracting position-specific update logic into named helpers.
   - Re-run `npm run quality:complexity`.

3. **Resolve production dependency vulnerabilities**
   - Replace or remove `numjs` if it is still required only for ML scaffolding; otherwise replace it with maintained numeric/ML packages.
   - Upgrade OpenTelemetry / OTLP / protobuf-related packages to versions that remove vulnerable `protobufjs` and `@grpc/proto-loader` paths.
   - Replace `quote-stream` / `static-eval` / `static-module` consumers or remove the code path that depends on them.
   - Re-run `npm run security:audit` until no high or critical production vulnerabilities remain.

4. **Run full CI parity locally**
   - Re-run `npm run quality:ci` after the coverage, complexity, and audit fixes above.
   - If CI still fails, capture the exact failing workflow/job and logs before opening a follow-up PR.

5. **Add production smoke and lifecycle tests**
   - Start the server on `PORT=3000` with the production config.
   - Verify public probes such as `/api/health/live`, `/api/health/quick`, and `/api/status`.
   - Add an automated lifecycle test that starts/stops the engine and asserts no open scheduler timers, queues, or listeners remain.

6. **Archive stale planning/QA reports**
   - Keep historical reports, but label them as historical or superseded.
   - Keep active docs (`AGENTS.md`, `README.md`, `CLAUDE.md`, `documentation/current_state_and_recommendations.md`) as the current-state source of truth.

7. **Final release checklist**
   - Confirm no generated artifacts are committed after test/coverage runs.
   - Confirm `.gitignore` keeps `coverage/`, SQLite WAL/SHM files, and Freqtrade runtime artifacts out of the repository.
   - Confirm branch cleanup is complete and the target branch is ahead of `origin/main`.
