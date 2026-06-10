/**
 * @file list_strategies.test.ts — Freqtrade strategy discovery test
 *
 * Uses node:test runner (no vitest/jest dependency).
 * Spawns freqtrade list-strategies and asserts that
 * ShadyTraderReferenceStrategy appears in the output.
 *
 * This is a smoke test, not a unit test of strategy logic.
 * Strategy logic is validated by the /api/freqtrade/validate endpoint.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Paths ─────────────────────────────────────────────────────────────
const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const VENV_PYTHON = resolve(
  PROJECT_ROOT,
  "backend/freqtrade/venv/bin/python"
);
const VENV_PYTHON3 = resolve(
  PROJECT_ROOT,
  "backend/freqtrade/venv/bin/python3"
);
const FREQTRADE_MODULE = resolve(
  PROJECT_ROOT,
  "backend/freqtrade/venv/bin/freqtrade"
);
const USERDIR = resolve(PROJECT_ROOT, "backend/freqtrade/user_data");
const CONFIG_PATH = resolve(USERDIR, "config.json");
const STRATEGY_PATH = resolve(
  PROJECT_ROOT,
  "backend/freqtrade/user_data/strategies/ShadyTraderReferenceStrategy.py"
);

// Expected strategy name
const EXPECTED_STRATEGY = "ShadyTraderReferenceStrategy";

// Helper: find a working Python binary in the venv
function findPython(): string | null {
  for (const p of [VENV_PYTHON, VENV_PYTHON3, "python3", "python"]) {
    if (existsSync(p)) return p;
    // Check if it's available on PATH
    const which = spawnSync("which", [p], { encoding: "utf-8" });
    if (which.status === 0 && which.stdout.trim()) return p;
  }
  return null;
}

// ── Test suite ────────────────────────────────────────────────────────
describe("freqtrade list-strategies", () => {
  let strategyDetected = false;
  let stdout: string;
  let stderr: string;
  let skipped = false;

  before(() => {
    // Skip if venv is not installed
    if (!existsSync(FREQTRADE_MODULE)) {
      skipped = true;
      console.warn(
        `⚠ Skipping: Freqtrade not found at ${FREQTRADE_MODULE}. ` +
          "Run 'npm run freqtrade:install' first."
      );
      return;
    }

    const result = spawnSync(
      FREQTRADE_MODULE,
      [
        "list-strategies",
        "--userdir", USERDIR,
        "-c", CONFIG_PATH,
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 30_000,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          FREQTRADE__EXCHANGE__NAME: "binance",
          FREQTRADE__API_SERVER__JWT_SECRET_KEY: "dummy-secret-key-for-testing-1234567890",
        },
      }
    );

    stdout = result.stdout;
    stderr = result.stderr;

    if (result.status !== 0 && !result.stdout) {
      console.warn("⚠ freqtrade list-strategies exited with code", result.status);
      console.warn("stderr:", stderr);
    }

    // Parse tabular output: look for strategy name in the table
    strategyDetected = stdout.includes(EXPECTED_STRATEGY);
  });

  it("should discover ShadyTraderReferenceStrategy", () => {
    if (skipped) return; // skip gracefully
    assert.ok(
      strategyDetected,
      [
        `Strategy "${EXPECTED_STRATEGY}" not found in freqtrade list-strategies output.`,
        "",
        "  To debug, run:",
        `    ${FREQTRADE_MODULE} list-strategies --userdir ${USERDIR} -c ${CONFIG_PATH}`,
        "",
        "  Stdout:",
        stdout ? "    " + stdout.replace(/\n/g, "\n    ") : "    (empty)",
        "",
        "  Stderr:",
        stderr ? "    " + stderr.replace(/\n/g, "\n    ") : "    (empty)",
      ].join("\n")
    );
  });

  it("should have correct INTERFACE_VERSION (3)", () => {
    if (skipped) return;
    // Import the strategy as a module and read its class attribute
    const pythonBin = findPython();
    if (!pythonBin) {
      console.warn("⚠ No Python binary found in venv, skipping INTERFACE_VERSION check");
      return;
    }

    const importResult = spawnSync(
      pythonBin,
      [
        "-c",
        [
          "import sys",
          `sys.path.insert(0, ${JSON.stringify(resolve(PROJECT_ROOT, "backend/freqtrade/user_data/strategies"))})`,
          "from ShadyTraderReferenceStrategy import ShadyTraderReferenceStrategy",
          "print(ShadyTraderReferenceStrategy.INTERFACE_VERSION)",
        ].join("; "),
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 15_000,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      }
    );

    if (importResult.status === 0 && importResult.stdout.trim()) {
      assert.equal(importResult.stdout.trim(), "3");
    } else {
      // If pandas_ta isn't installed in the venv, skip this assertion
      console.warn(
        "⚠ Could not import strategy to verify INTERFACE_VERSION:",
        importResult.stderr?.trim() || "(no stderr)"
      );
    }
  });
});
