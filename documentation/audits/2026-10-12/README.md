# Live review evidence

Reviewed application commit: `52fdae370fcaa9abfa81956ca30b30ff14155e50`.

`live-snapshots.json` preserves selected read-only local/public responses from two capture windows. Large Kraken/OKX arrays are reduced to counts and endpoint rows. `comparison.json` includes the original completed-candle comparison and read-only SQLite rows; `comparison-refreshed.json` preserves the later successful sample. Browser evidence preserves API status, received performance frames, layout measurements and screenshots. Request credentials and outbound WebSocket authentication frames are omitted.

The `.txt` files preserve the exact audit scripts rather than adding executable application/tests code. They reference `/tmp/shady-trader-human-test` and `/tmp/shady-live-review`, the environment used for this review. To reproduce there, copy the relevant `.txt` script to its original basename in `/tmp/shady-live-review` and use Node 22 with that clone's dependencies. The HTTP/browser scripts read local credentials from the clone's `.env`; do not print or archive that file.

The accounting harness ran as:

```sh
/home/creekz/.nvm/versions/node/v22.23.3/bin/node --import /tmp/shady-trader-human-test/node_modules/tsx/dist/loader.mjs /tmp/shady-live-review/accounting-repros.ts
```

It uses actual production methods, mocked trade queries and in-memory SQLite for wallet arithmetic. The mode-switch fixture stages entry ownership; the mocked transaction wrapper does not prove database rollback semantics. Fees/slippage are zeroed to isolate arithmetic. It makes no exchange calls or real-database mutations. Logging may write ordinary ignored application logs. Exit zero means the harness collected results successfully, not that the application passed the expected invariants: compare each `expected` field to its actual result.

The browser script launches actual Chromium against the running app and authenticates with both local roles. It reads dashboards and panels, and changes viewport size; it does not change engine configuration or place orders. The HTTP script performs GET requests only. The later HTTP collection used `AUDIT_OUTPUT_DIR=/tmp/shady-live-review/oct12` to preserve the first sample. Full temporary raw captures remain in `/tmp/shady-live-review` for this workspace session; the compact durable evidence here supports the report.

These artifacts are bounded observations and isolated reproductions, not an all-exchange execution certification, continuous soak, new security audit, or completed production release gate.
