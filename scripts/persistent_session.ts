#!/usr/bin/env npx tsx
// ─────────────────────────────────────────────────────────────────
// Persistent Browser Session — API Key Collection
// ─────────────────────────────────────────────────────────────────
// Opens a cloud browser you control via a Live View URL.
// Navigates to each service's login page, waits for you to log in,
// then navigates to the API key page. You read the keys from the
// Live View and paste them into the terminal.
//
// SETUP:
//   export HYPERBROWSER_API_KEY="hb_your_key_here"
//   npm install @hyperbrowser/sdk playwright-core dotenv
//
// RUN:
//   npx tsx scripts/persistent_session.ts                  # all 8
//   npx tsx scripts/persistent_session.ts coingecko        # one
//   npx tsx scripts/persistent_session.ts binance kraken   # specific
//
// Services:
//   coingecko, coinmarketcap, coinapi, cryptocompare,
//   binance, kraken, gemini, okx
// ─────────────────────────────────────────────────────────────────

import { chromium } from "playwright-core";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

config();

// ── Service definitions ─────────────────────────────────────────

const SERVICES: Record<string, {
  name: string;
  loginUrl: string;
  apiKeyPageUrl: string;
  creds: { envVar: string; label: string }[];
  tips: string;
}> = {
  coingecko: {
    name: "CoinGecko",
    loginUrl: "https://www.coingecko.com/en/account/sign_in",
    apiKeyPageUrl: "https://www.coingecko.com/en/api/coin_gecko_api",
    creds: [{ envVar: "COINGECKO_API_KEY", label: "API Key" }],
    tips: "Free tier: rate-limited. Key bumps you to 500 req/min.",
  },
  coinmarketcap: {
    name: "CoinMarketCap",
    loginUrl: "https://coinmarketcap.com/account/sign_in/",
    apiKeyPageUrl: "https://coinmarketcap.com/api/key/",
    creds: [{ envVar: "EXCHANGE_API_KEY", label: "API Key" }],
    tips: "Free tier: 10,000 credits/month.",
  },
  coinapi: {
    name: "CoinAPI",
    loginUrl: "https://www.coinapi.io/login",
    apiKeyPageUrl: "https://www.coinapi.io/keys",
    creds: [{ envVar: "COINAPI_API_KEY", label: "API Key" }],
    tips: "Free tier: 100 req/day.",
  },
  cryptocompare: {
    name: "CryptoCompare",
    loginUrl: "https://www.cryptocompare.com/register",
    apiKeyPageUrl: "https://www.cryptocompare.com/cryptopian/api-keys",
    creds: [{ envVar: "CRYPTOCOMPARE_API_KEY", label: "API Key" }],
    tips: "Free tier: 100K calls/month.",
  },
  binance: {
    name: "Binance",
    loginUrl: "https://www.binance.com/en/login",
    apiKeyPageUrl: "https://www.binance.com/en/my/settings/api-management",
    creds: [
      { envVar: "EXCHANGE_API_KEY", label: "API Key" },
      { envVar: "EXCHANGE_API_SECRET", label: "Secret Key" },
    ],
    tips: "Enable 'Read' + 'Spot Trading' ONLY. No withdrawals.",
  },
  kraken: {
    name: "Kraken",
    loginUrl: "https://www.kraken.com/sign-in",
    apiKeyPageUrl: "https://www.kraken.com/settings/api",
    creds: [
      { envVar: "EXCHANGE_API_KEY", label: "API Key" },
      { envVar: "EXCHANGE_API_SECRET", label: "Private Key (base64)" },
    ],
    tips: "Enable 'Query Funds' + 'Query Open Orders/Trades'.",
  },
  gemini: {
    name: "Google Gemini",
    loginUrl: "https://accounts.google.com/signin",
    apiKeyPageUrl: "https://aistudio.google.com/apikey",
    creds: [{ envVar: "GEMINI_API_KEY", label: "API Key" }],
    tips: "Sign in with moshuprecords@gmail.com, then click 'Get API key'.",
  },
  okx: {
    name: "OKX",
    loginUrl: "https://www.okx.com/account/login",
    apiKeyPageUrl: "https://www.okx.com/account/my-api",
    creds: [
      { envVar: "EXCHANGE_API_KEY", label: "API Key" },
      { envVar: "EXCHANGE_API_SECRET", label: "Secret Key" },
      { envVar: "EXCHANGE_API_PASSWORD", label: "Passphrase (you create this)" },
    ],
    tips: "Enable 'Trade' only. You set the passphrase yourself.",
  },
};

// ── Helpers ─────────────────────────────────────────────────────

const OUTPUT_DIR = path.resolve(process.cwd(), "api-keys-collected");

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(question, ans => { rl.close(); resolve(ans.trim()); })
  );
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  // Validate
  if (!process.env.HYPERBROWSER_API_KEY) {
    console.error("\n  Error: HYPERBROWSER_API_KEY not set.");
    console.error("  Get one at: https://app.hyperbrowser.ai/settings");
    console.error("  Then: export HYPERBROWSER_API_KEY=\"hb_...\"\n");
    process.exit(1);
  }

  const client = new Hyperbrowser({ apiKey: process.env.HYPERBROWSER_API_KEY });

  // Parse service args
  const serviceIds = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const toCollect = serviceIds.length > 0
    ? serviceIds.filter(id => {
        if (!SERVICES[id]) {
          console.error(`  Unknown service: "${id}". Available: ${Object.keys(SERVICES).join(", ")}`);
          return false;
        }
        return true;
      })
    : Object.keys(SERVICES);

  if (toCollect.length === 0) process.exit(1);

  ensureOutputDir();

  // Stop any stale sessions (free plan = 1 max)
  const existing = await client.sessions.list({});
  for (const s of existing.sessions) {
    if (s.status === "active") {
      await client.sessions.stop(s.id);
      console.log(`  Stopped stale session: ${s.id}`);
    }
  }

  // Create persistent session
  console.log("\n  Creating browser session (30 min timeout)...");
  const session = await client.sessions.create({
    acceptCookies: true,
    useStealth: true,
    screen: { width: 1920, height: 1080 },
    timeoutMinutes: 30,
  });

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  BROWSER SESSION READY                                          ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Live View (open this NOW):                                      ║
║  ${session.sessionUrl?.padEnd(60)}║
║                                                                  ║
║  You will see the remote browser screen.                        ║
║  Click and type directly in the Live View.                      ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
  Services to collect: ${toCollect.map(id => SERVICES[id].name).join(", ")}
  `);

  // Connect via Playwright
  console.log("  Connecting to browser via Playwright...");
  const browser = await chromium.connectOverCDP(session.wsEndpoint!);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  const collected: Record<string, string> = {};

  for (const serviceId of toCollect) {
    const svc = SERVICES[serviceId];

    console.log(`\n${"━".repeat(64)}`);
    console.log(`  SERVICE: ${svc.name}`);
    console.log(`  TIP: ${svc.tips}`);
    console.log(`${"━".repeat(64)}`);

    // Step 1: Navigate to login
    console.log(`\n  [1/3] Opening login page...`);
    try {
      await page.goto(svc.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      console.log(`  (page load timed out, continuing anyway)`);
    }
    await sleep(2000);
    console.log(`        URL: ${page.url()}`);
    console.log(`        Title: ${await page.title()}`);

    // Step 2: Wait for user login
    console.log(`\n  [2/3] >>> LOG IN VIA THE LIVE VIEW <<<`);
    console.log(`        Use the browser screen above to log in.`);
    console.log(`        When done, come back here and press Enter.`);
    await ask(`\n  Press Enter after logging in to ${svc.name}...`);

    // Step 3: Navigate to API key page
    console.log(`\n  [3/3] Opening API key page...`);
    try {
      await page.goto(svc.apiKeyPageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      console.log(`  (page load timed out, continuing anyway)`);
    }
    await sleep(3000);
    console.log(`        URL: ${page.url()}`);
    console.log(`        Title: ${await page.title()}`);

    // Screenshot
    const ss = path.join(OUTPUT_DIR, `${serviceId}_screenshot.png`);
    await page.screenshot({ path: ss, fullPage: false });
    console.log(`        Screenshot: ${ss}`);

    // Step 4: User reads keys from live view, enters them here
    console.log(`\n  Look at the Live View screen above.`);
    console.log(`  Find your API key(s) on the page and type them below.`);
    console.log(`  Press Enter without typing to skip this service.\n`);

    for (const cred of svc.creds) {
      const val = await ask(`  ${cred.label} (${cred.envVar}): `);
      if (val) {
        collected[cred.envVar] = val;
        console.log(`    ✓ Saved.`);
      } else {
        console.log(`    (skipped)`);
      }
    }
  }

  // Write results
  if (Object.keys(collected).length > 0) {
    const outFile = path.join(OUTPUT_DIR, "credentials.env");
    const lines = [
      `# Collected ${new Date().toISOString()}`,
      `# Copy into .env and delete this file`,
      ``,
    ];
    for (const [k, v] of Object.entries(collected)) {
      lines.push(`${k}=${v}`);
    }
    fs.appendFileSync(outFile, lines.join("\n") + "\n\n");

    console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  CREDENTIALS SAVED                                          ║`);
    console.log(`╠══════════════════════════════════════════════════════════════╣`);
    console.log(`║  File: api-keys-collected/credentials.env`);
    for (const [k, v] of Object.entries(collected)) {
      const masked = v.length > 10 ? v.slice(0, 6) + "****" + v.slice(-4) : "****";
      console.log(`║  ${k} = ${masked}`);
    }
    console.log(`╚══════════════════════════════════════════════════════════════╝`);
  } else {
    console.log(`\n  No credentials entered.`);
  }

  // Keep alive for review, then close
  console.log(`\n  Session stays open for 2 minutes for final review.`);
  console.log(`  Live View: ${session.sessionUrl}`);
  console.log(`  Press Ctrl+C to close now, or wait.\n`);

  await sleep(120_000);
  await client.sessions.stop(session.id);
  console.log("  Session closed.");
}

main().catch(e => {
  console.error(`\n  Fatal: ${e.message}`);
  process.exit(1);
});
