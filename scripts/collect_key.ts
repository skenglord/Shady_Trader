#!/usr/bin/env npx tsx
// ─────────────────────────────────────────────────────────────────
// Single-service API key collector — one service at a time
// ─────────────────────────────────────────────────────────────────
// Usage:
//   npx tsx scripts/collect_key.ts coingecko
//   npx tsx scripts/collect_key.ts binance --manual
// ─────────────────────────────────────────────────────────────────

import { Hyperbrowser } from "@hyperbrowser/sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";

config();

const SERVICES: Record<string, {
  name: string;
  loginUrl: string;
  apiKeyPageUrl: string;
  creds: string[];
  notes: string;
}> = {
  coingecko: {
    name: "CoinGecko",
    loginUrl: "https://www.coingecko.com/en/account/sign_in",
    apiKeyPageUrl: "https://www.coingecko.com/en/api/coin_gecko_api",
    creds: ["COINGECKO_API_KEY"],
    notes: "Free tier: rate-limited. Key increases to 500 req/min.",
  },
  coinmarketcap: {
    name: "CoinMarketCap",
    loginUrl: "https://coinmarketcap.com/account/sign_in/",
    apiKeyPageUrl: "https://coinmarketcap.com/api/key/",
    creds: ["EXCHANGE_API_KEY"],
    notes: "Free tier: 10,000 credits/month.",
  },
  coinapi: {
    name: "CoinAPI",
    loginUrl: "https://www.coinapi.io/login",
    apiKeyPageUrl: "https://www.coinapi.io/keys",
    creds: ["COINAPI_API_KEY"],
    notes: "Free tier: 100 req/day.",
  },
  cryptocompare: {
    name: "CryptoCompare",
    loginUrl: "https://www.cryptocompare.com/register",
    apiKeyPageUrl: "https://www.cryptocompare.com/cryptopian/api-keys",
    creds: ["CRYPTOCOMPARE_API_KEY"],
    notes: "Free tier: 100K calls/month.",
  },
  binance: {
    name: "Binance",
    loginUrl: "https://www.binance.com/en/login",
    apiKeyPageUrl: "https://www.binance.com/en/my/settings/api-management",
    creds: ["EXCHANGE_API_KEY", "EXCHANGE_API_SECRET"],
    notes: "Testnet recommended. Enable read + spot trading ONLY.",
  },
  kraken: {
    name: "Kraken",
    loginUrl: "https://www.kraken.com/sign-in",
    apiKeyPageUrl: "https://www.kraken.com/settings/api",
    creds: ["EXCHANGE_API_KEY", "EXCHANGE_API_SECRET"],
    notes: "Key = API Key. Secret = Private Key (base64).",
  },
  gemini: {
    name: "Google Gemini",
    loginUrl: "https://accounts.google.com/signin",
    apiKeyPageUrl: "https://aistudio.google.com/apikey",
    creds: ["GEMINI_API_KEY"],
    notes: "Google account required. Free tier available.",
  },
  okx: {
    name: "OKX",
    loginUrl: "https://www.okx.com/account/login",
    apiKeyPageUrl: "https://www.okx.com/account/my-api",
    creds: ["EXCHANGE_API_KEY", "EXCHANGE_API_SECRET", "EXCHANGE_API_PASSWORD"],
    notes: "3 creds: key, secret, passphrase (user-defined).",
  },
};

const OUTPUT_DIR = path.resolve(process.cwd(), "api-keys-collected");

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function maskValue(v: string, n = 6) {
  return v.length <= n ? "****" : v.slice(0, n) + "****" + v.slice(-4);
}

async function main() {
  const serviceId = process.argv[2];
  const isManual = process.argv.includes("--manual");

  if (!serviceId || !SERVICES[serviceId]) {
    console.error(`Usage: npx tsx scripts/collect_key.ts <service> [--manual]`);
    console.error(`Services: ${Object.keys(SERVICES).join(", ")}`);
    process.exit(1);
  }

  if (!process.env.HYPERBROWSER_API_KEY) {
    console.error("Set HYPERBROWSER_API_KEY first.");
    process.exit(1);
  }

  const svc = SERVICES[serviceId];
  const client = new Hyperbrowser({ apiKey: process.env.HYPERBROWSER_API_KEY });

  ensureOutputDir();

  // Create a fresh session
  console.log(`\nCreating session for ${svc.name}...`);
  const session = await client.sessions.create({
    acceptCookies: true,
    useStealth: true,
    screen: { width: 1920, height: 1080 },
    timeoutMinutes: 10,
  });

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  SERVICE: ${svc.name}`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  Open this URL to view/interact with the browser:`);
  console.log(`║  ${session.sessionUrl}`);
  console.log(`║`);
  console.log(`║  Login URL: ${svc.loginUrl}`);
  console.log(`║  API Keys:  ${svc.apiKeyPageUrl}`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  if (isManual) {
    console.log(`--manual mode: Session is open. Log in at the URLs above.`);
    console.log(`Press Ctrl+C when done. The session will stay alive.\n`);
    // Keep alive for 10 minutes
    await new Promise(r => setTimeout(r, 600_000));
    await client.sessions.stop(session.id);
    return;
  }

  // Automated approach: agent navigates to API key page
  const isExchange = ["binance", "kraken", "okx"].includes(serviceId);
  const credLabels = svc.creds.map(c => {
    if (c.includes("SECRET")) return "Secret Key";
    if (c.includes("PASSWORD")) return "Passphrase";
    return "API Key";
  }).join(", ");

  let task: string;

  if (isExchange) {
    task = `Navigate to ${svc.apiKeyPageUrl}. If a login wall appears, report: LOGIN_REQUIRED. If the page loads and shows API keys, look for any key pair named "shady-trader" or "trading-bot". If found, extract and report ALL credential values (${credLabels}) in strict JSON format: {"status":"success","credentials":{"ENV_VAR":"value"}}. If no key exists, click "Create API Key", name it "shady-trader", enable Read + Spot Trading ONLY (no withdrawals), and report the generated ${credLabels}. If login is needed, output: {"status":"login_required","notes":"log in manually"}`;
  } else {
    task = `Navigate to ${svc.apiKeyPageUrl}. If a login or Cloudflare challenge blocks you, report: LOGIN_REQUIRED. If the page loads and shows API keys, look for any existing key. If found, extract and report the full key value in JSON: {"status":"success","credentials":{"ENV_VAR":"value"}}. If no key exists, click "Create API Key" or "Get API key", name it "shady-trader", and report the generated key value. If you cannot proceed, output: {"status":"login_required","notes":"reason"}`;
  }

  console.log(`Running browser agent...`);
  try {
    const result = await client.agents.browserUse.startAndWait({
      task,
      llm: "gemini-2.5-flash",
      maxSteps: 40,
      useVision: true,
      sessionId: session.id,
      keepBrowserOpen: true,
      sensitiveData: { x_google_email: "moshuprecords@gmail.com" },
    });

    const output = result.data?.finalResult ?? "";
    console.log(`\nAgent result:\n${output}\n`);

    // Save raw
    fs.writeFileSync(path.join(OUTPUT_DIR, `${serviceId}_raw.txt`), output);

    // Try parse JSON
    const match = output.match(/\{[\s\S]*"status"[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.status === "success" && parsed.credentials) {
        const envFile = path.join(OUTPUT_DIR, "credentials.env");
        const lines = [`# ${svc.name} — ${new Date().toISOString()}`];
        for (const [k, v] of Object.entries(parsed.credentials)) {
          if (typeof v === "string") {
            lines.push(`${k}=${v}`);
            console.log(`  ${k} = ${maskValue(v)}`);
          }
        }
        fs.appendFileSync(envFile, lines.join("\n") + "\n\n");
        console.log(`\nSaved to ${envFile}`);
      } else {
        console.log(`\nStatus: ${parsed.status}`);
        console.log(`Manual login required. Open: ${session.sessionUrl}`);
        console.log(`Log in, then re-run: npx tsx scripts/collect_key.ts ${serviceId}`);
      }
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    console.log(`Session still open: ${session.sessionUrl}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
