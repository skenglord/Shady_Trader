# Security and deployment evidence — 10 October 2026

Scope: current source, isolated mocks/middleware, and deployment configuration. No operator secrets or database contents were read to demonstrate disclosure. Findings describe exposure when a client can reach the application; loopback binding reduces exposure but does not repair missing authorization. See the main audit for test results and advisory reachability.

## S1 — P1: malformed unauthenticated WebSocket message can terminate the server

`backend/api/websocket.ts:63` parses JSON inside a try/catch, but `:71` accesses `data.type` outside it. Valid JSON can be `null`, so an unauthenticated message raises a TypeError rather than closing the connection. The exception propagates from the EventEmitter callback. `server.ts:523-527` handles uncaught exceptions by scheduling process exit.

A stub-socket/VM reproduction confirmed the exception without crashing an operational service. This is an availability failure before token verification. Validate that decoded messages are non-null objects with the required typed fields, handle errors for each socket, and test malformed/oversize frames against an isolated server. Default sockets also lack a per-socket error handler; verify payload-limit error behavior as part of the same boundary fix.

## S2 — P1: paper REST and symbol mutation bypass role middleware

`backend/api/routes.ts:267` and `:297` define protected prefix lists. Neither `/paper` nor `/symbol` is included. Their handlers are mounted at `:2012` and `:809`; the paper controller contains no independent token authentication. The later CSRF middleware (`:509`) accepts the presence of an `x-api-token` or Bearer header without verifying its value. Consequently a caller can supply an arbitrary value and reach these mutations; paper reads require no CSRF token at all.

The symbol mutation persists configuration and invokes engine pair switching, combining with the wrong-symbol position-pricing finding. Paper endpoints expose state and allow simulation mutations. Mount authentication at each router boundary with explicit public exemptions, then enumerate every route in missing/invalid/valid token tests. CSRF bypass must depend on established authentication, not header presence. A valid session CSRF token is not a replacement for authorization.

## S3 — P1: paper WebSocket emits private state before authentication

`backend/main.ts:369-377` attaches the paper handler on connection based on a URL substring. It does not await the shared first-message authentication. `backend/paper-trading/websocket-handler.ts:29-38` immediately registers the client and starts initial data transmission. Lines 76-99 send positions and P&L; the handler's send path checks socket readiness, not `authed`.

A fake socket with `authed=false` received both message types using a stub service. The shared handler's later authentication timeout cannot undo this disclosure. Route authenticated connections only after `auth_ok`, require authorization in every send/subscription path, and use an exact endpoint path rather than a substring match.

## S4 — P1: development middleware exposes denied source and root data files

`server.ts:468-480` denies selected raw request paths. Vite subsequently canonicalizes/resolves paths differently. An isolated middleware harness using the installed Vite and the actual deny middleware returned 404 for a directly denied backend path but 200 for the equivalent Vite filesystem path and a percent-encoded variant. The harness also received 200 for a harmless root `.db` sentinel. No original database or `.env` was requested.

The deny list omits `trading.db`, its WAL/SHM files, and root shutdown-backup names. Those paths therefore expose application data under the same root-serving behavior. Backend source disclosure was directly demonstrated; disclosure of real database contents was deliberately not exercised. This applies to the non-production branch at `server.ts:483`, including deployments that run the development command; it is not a claim that production `dist` serving exposes the repository.

Evidence harness: `/tmp/shady-security-vite-repro.cjs`, snapshot root `/tmp/shady-audit-20261010`; reproduced under Node 22. Restrict the Vite filesystem root to required frontend resources, canonicalize before access decisions, keep application data outside served roots, and test alternative/encoded paths. Treat production static serving as a separate configuration to verify.

## O1 — P1: final image fails import and application Deployment has undefined mounts

`Dockerfile:37-42` copies dist, dependencies, backend, package.json and server.ts into the runner, but omits root seed.ts. `server.ts:15` statically imports `./seed.js` (resolved to TypeScript during TSX execution). Building only the frontend does not bundle this dependency. A temporary recreation of that file layout failed with `ERR_MODULE_NOT_FOUND` for seed.js under Node 22. Docker itself was not built/run. Include all backend runtime imports or produce a tested backend bundle.

Separately, the backend fluent-bit container in `k8s/deployment.yaml` mounts `fluent-bit-config`, `varlogcontainers`, `varlogpods`, and `varlibdockercontainers`. Their definitions at lines 80-91 are under the preceding PostgreSQL pod, not the application pod. YAML parsing succeeds but the application's mount references have no matching volumes. Move/add volumes to the correct pod and validate semantic references using Kubernetes server-side dry-run or equivalent before deployment.

## O2 — P1: HPA defeats the single-engine restriction

`k8s/deployment.yaml:101-103` explicitly requires a single owner and sets replicas to 1. `k8s/hpa.yaml:12-13` targets that deployment with minimum 2 and maximum 10. The package `k8s:deploy` script applies the whole directory. Each app process initializes its engine (`server.ts:392`), so the HPA reintroduces multiple independent in-memory portfolios/lifecycle owners sharing infrastructure. Entry locks alone do not serialize all exits, balances, or schedulers.

Disable engine autoscaling until execution ownership is durable, or separate stateless API replicas from one fenced engine owner. Prove ownership during rolling deployment, crash/restart, lease expiry, and network partition. This risk is conditional on deployment after the manifest defects above are repaired; no cluster was changed during audit.

## O3 — P1: backup does not produce a reliable snapshot of the configured database

`backend/database.ts:20` enables WAL. `backend/backup.ts:14` copies only the main SQLite file using fs.copyFile; committed transactions still in the WAL are omitted. Copying a changing main file is also not a coordinated online snapshot. The function does not branch on `USE_POSTGRES`, despite PostgreSQL deployment configuration, so it can back up an unrelated SQLite file or log a missing-file error while the actual database remains unprotected. Errors are swallowed after logging (`:17-19`).

Use the SQLite backup API or another coordinated snapshot method, native PostgreSQL backup for that backend, explicit success/failure reporting, and a restore drill that verifies recent transactions, schemas and accounting invariants. Current file-copy/rotation tests do not establish recoverability.

## Advisory qualification and limitations

No Express `trust proxy` configuration was found. The critical proxy-addr advisory requires particular vulnerable trust-subnet configuration, so it is an upgrade requirement rather than an application exploit demonstrated here. OpenTelemetry/gRPC/source-map advisory reachability also was not demonstrated.

No live penetration test, credential rotation, account access, production crash, original-data download, Docker daemon build, cluster apply, backup restoration or external notification occurred. Authentication findings were traced in source and checked with isolated handlers; the Vite harness used a Git snapshot and sentinel. These checks establish defects, not the current exposure of an unknown deployed environment.
