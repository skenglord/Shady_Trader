#!/usr/bin/env npx tsx
// ─────────────────────────────────────────────────────────────────
// Hyperbrowser — Automated External Service API Key Collection
// ─────────────────────────────────────────────────────────────────
// Uses Hyperbrowser's browser-use agent to navigate to 8 external
// services, log in, and retrieve/create API keys.
//
// Prerequisites:
//   npm install @hyperbrowser/sdk dotenv
//   export HYPERBROWSER_API_KEY="your-hyperbrowser-key"
//
// Usage:
//   npx tsx scripts/hyperbrowser_collect_keys.ts
//   npx tsx scripts/hyperbrowser_collect_keys.ts --service coingecko
//   npx tsx scripts/hyperbrowser_collect_keys.ts --dry-run
// ─────────────────────────────────────────────────────────────────

import { Hyperbrowser } from "@hyperbrowser/sdk";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";

config();

// ─── Types ──────────────────────────────────────────────────────

interface ServiceConfig {
  id: string;
  name: string;
  url: string;
  loginUrl: string;
  apiKeyPageUrl: string;
  credentialsNeeded: string[];
  notes: string;
}

interface CollectedCredential {
  service: string;
  envVar: string;
  value: string;
  source: "existing" | "new";
  timestamp: string;
}

// ─── Service Definitions ────────────────────────────────────────

const SERVICES: ServiceConfig[] = [
  {
    id: "coingecko",
    name: "CoinGecko",
    url: "https://www.coingecko.com",
    loginUrl: "https://www.coingecko.com/en/account/sign_in",
    apiKeyPageUrl: "https://www.coingecko.com/en/api/coin_gecko_api",
    credentialsNeeded: ["COINGECKO_API_KEY"],
    notes: "Free tier available. No key needed for basic use, key increases rate limits from 10-30 req/min to 500 req/min.",
  },
  {
    id: "coinmarketcap",
    name: "CoinMarketCap",
    url: "https://coinmarketcap.com",
    loginUrl: "https://coinmarketcap.com/account/sign_in/",
    apiKeyPageUrl: "https://coinmarketcap.com/api/key/",
    credentialsNeeded: ["EXCHANGE_API_KEY"],
    notes: "Free tier: Basic plan with 10,000 API credits/month. Key is the API Key string.",
  },
  {
    id: "coinapi",
    name: "CoinAPI",
    url: "https://www.coinapi.io",
    loginUrl: "https://www.coinapi.io/login",
    apiKeyPageUrl: "https://www.coinapi.io/keys",
    credentialsNeeded: ["COINAPI_API_KEY"],
    notes: "Free tier: 100 requests/day. Key appears as a GUID-style string.",
  },
  {
    id: "cryptocompare",
    name: "CryptoCompare",
    url: "https://www.cryptocompare.com",
    loginUrl: "https://www.cryptocompare.com/register",
    apiKeyPageUrl: "https://www.cryptocompare.com/cryptopian/api-keys",
    credentialsNeeded: ["CRYPTOCOMPARE_API_KEY"],
    notes: "Free tier: 100,000 calls/month. Key is a 32-char hex string.",
  },
  {
    id: "binance",
    name: "Binance",
    url: "https://www.binance.com",
    loginUrl: "https://www.binance.com/en/login",
    apiKeyPageUrl: "https://www.binance.com/en/my/settings/api-management",
    credentialsNeeded: ["EXCHANGE_API_KEY", "EXCHANGE_API_SECRET"],
    notes: "Testnet recommended for development. Enable 'Enable Spot & Margin Trading'. Do NOT enable withdrawal permissions.",
  },
  {
    id: "kraken",
    name: "Kraken",
    url: "https://www.kraken.com",
    loginUrl: "https://www.kraken.com/sign-in",
    apiKeyPageUrl: "https://www.kraken.com/settings/api",
    credentialsNeeded: ["EXCHANGE_API_KEY", "EXCHANGE_API_SECRET"],
    notes: "Key is the API Key. Secret is the Private Key (base64-encoded). Enable 'Query Funds' + 'Query Open Orders/Trades' at minimum.",
  },
  {
    id: "gemini",
    name: "Google Gemini (AI Studio)",
    url: "https://aistudio.google.com",
    loginUrl: "https://accounts.google.com/signin",
    apiKeyPageUrl: "https://aistudio.google.com/apikey",
    credentialsNeeded: ["GEMINI_API_KEY"],
    notes: "Requires Google account (moshuprecords@gmail.com). Free tier available. Key is created from 'Get API Key' button.",
  },
  {
    id: "okx",
    name: "OKX",
    url: "https://www.okx.com",
    loginUrl: "https://www.okx.com/account/login",
    apiKeyPageUrl: "https://www.okx.com/account/my-api",
    credentialsNeeded: ["EXCHANGE_API_KEY", "EXCHANGE_API_SECRET", "EXCHANGE_API_PASSWORD"],
    notes: "Requires 3 credentials: API Key, Secret Key, and Passphrase (user-defined). Enable 'Trade' permission only.",
  },
];

// ─── Output File ────────────────────────────────────────────────

const OUTPUT_DIR = path.resolve(process.cwd(), "api-keys-collected");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "credentials.env");
const README_FILE = path.join(OUTPUT_DIR, "README.md");

// ─── Helpers ────────────────────────────────────────────────────

function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function maskValue(value: string, showChars = 6): string {
  if (value.length <= showChars) return "****";
  return value.slice(0, showChars) + "****" + value.slice(-4);
}

// ─── Core Task Builder ──────────────────────────────────────────

function buildTaskForService(service: ServiceConfig, googleEmail: string): string {
  const isCryptoExchange = ["binance", "kraken", "okx"].includes(service.id);
  const isGoogle = service.id === "gemini";

  let loginInstructions: string;

  if (isGoogle) {
    loginInstructions = `
LOGIN STEPS:
1. Navigate to: ${service.loginUrl}
2. Enter the Google email: ${googleEmail}
3. If a password prompt appears, STOP and report "Google password required" — do NOT enter any password.
4. If already logged in, proceed to step 5.
5. After successful login, navigate to: ${service.apiKeyPageUrl}
6. Look for any existing API key on the page and report it.
7. If no key exists, click "Create API key" or "Get API key" button.
8. Give it a name like "shady-trader" or "trading-bot".
9. Report the generated API key value.`;
  } else if (isCryptoExchange) {
    const credList = service.credentialsNeeded.map(c => {
      if (c.includes("SECRET")) return "API Secret Key";
      if (c.includes("PASSWORD")) return "API Passphrase";
      return "API Key";
    }).join(", ");

    loginInstructions = `
LOGIN STEPS:
1. Navigate to: ${service.loginUrl}
2. The user will need to log in manually (exchange auth is complex — 2FA, captchas, etc.)
3. Report "LOGIN_REQUIRED" and wait for the user to confirm they are logged in.
4. Once confirmed, navigate to: ${service.apiKeyPageUrl}
5. Look for any existing API key pair labeled "shady-trader" or "trading-bot".
6. If found, report the existing ${credList}.
7. If NOT found, click "Create API Key" or "Generate New Key".
8. Name it "shady-trader".
9. IMPORTANT PERMISSIONS: Enable "Read" and "Spot Trading" ONLY. Do NOT enable withdrawal permissions.
10. Report ALL credentials: ${credList}.`;
  } else {
    loginInstructions = `
LOGIN STEPS:
1. Navigate to: ${service.loginUrl}
2. Look for a "Sign in with Google" or "Sign in with GitHub" button.
3. If available, click it and select the Google account: ${googleEmail}
4. If no Google SSO, prompt: "Please enter your ${service.name} email and password in the browser."
5. After login, navigate to: ${service.apiKeyPageUrl}
6. Look for any existing API key on the page.
7. If found, report it with its name/label.
8. If NOT found, click "Create API Key" or "Generate Key".
9. Name it "shady-trader".
10. Report the generated API key value.`;
  }

  return `You are an API key collection agent for a trading system. Your job is to navigate to ${service.name}, log in, and retrieve or create an API key.

TARGET SERVICE: ${service.name}
SERVICE URL: ${service.url}
API KEY PAGE: ${service.apiKeyPageUrl}
CREDENTIALS NEEDED: ${service.credentialsNeeded.join(", ")}

${loginInstructions}

IMPORTANT RULES:
- Do NOT enter any passwords yourself — only the email/login identifier.
- For Google OAuth: only enter the email, then STOP at the password screen.
- For exchange logins (Binance, Kraken, OKX): report "LOGIN_REQUIRED" and let the human handle the actual login.
- After login, ALWAYS navigate to the API key management page.
- Report ALL credential values you find (keys, secrets, passphrases).
- If the page shows an existing key named "shady-trader" or similar, use that — do NOT create a duplicate.
- If creating a new key, use the name "shady-trader" and appropriate permissions.
- For API keys: report the FULL value. Do NOT mask it.
- For secrets/passphrases: report the FULL value. Do NOT mask it.

OUTPUT FORMAT (strict JSON):
{
  "status": "success" | "login_required" | "error",
  "service": "${service.id}",
  "credentials": {
    "ENV_VAR_NAME": "actual_value"
  },
  "keyName": "name-of-the-key",
  "permissions": "description of permissions",
  "notes": "any relevant notes"
}`;
}

// ─── Sensitive Data for Browser-Use Agent ───────────────────────

function buildSensitiveData(service: ServiceConfig): Record<string, string> {
  const sensitive: Record<string, string> = {};

  // Mask the email so the LLM doesn't see the raw value in prompts
  sensitive.x_google_email = "moshuprecords@gmail.com";

  // Mask any pre-existing keys we might have
  if (process.env[service.credentialsNeeded[0]]) {
    sensitive.x_existing_key = process.env[service.credentialsNeeded[0]]!;
  }

  return sensitive;
}

// ─── Collection Runner ──────────────────────────────────────────

async function collectForService(
  client: Hyperbrowser,
  service: ServiceConfig,
  googleEmail: string,
  existingSessionId?: string
): Promise<CollectedCredential[]> {
  ensureOutputDir();
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SERVICE: ${service.name}`);
  console.log(`  URL: ${service.apiKeyPageUrl}`);
  console.log(`  Credentials needed: ${service.credentialsNeeded.join(", ")}`);
  console.log(`${"═".repeat(60)}\n`);

  const task = buildTaskForService(service, googleEmail);
  const sensitiveData = buildSensitiveData(service);

  const collected: CollectedCredential[] = [];

  try {
    const result = await client.agents.browserUse.startAndWait({
      task,
      llm: "gemini-2.5-flash",
      maxSteps: 50,
      useVision: true,
      keepBrowserOpen: !!existingSessionId,
      sessionId: existingSessionId,
      sensitiveData,
      sessionOptions: existingSessionId
        ? undefined
        : {
            acceptCookies: true,
            useStealth: true,
            solveCaptchas: true,
            screen: { width: 1920, height: 1080 },
            timeoutMinutes: 15,
          },
    });

    const finalResult = result.data?.finalResult ?? "";
    console.log(`Agent output:\n${finalResult}\n`);

    // Parse the JSON output from the agent
    const jsonMatch = finalResult.match(/\{[\s\S]*"status"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);

        if (parsed.status === "login_required") {
          console.log(`⚠  ${service.name}: Manual login required.`);
          console.log(`   Open the live session URL and log in manually, then re-run.`);
          return collected;
        }

        if (parsed.status === "success" && parsed.credentials) {
          for (const [envVar, value] of Object.entries(parsed.credentials)) {
            if (typeof value === "string" && value.length > 0) {
              collected.push({
                service: service.id,
                envVar: envVar,
                value: value,
                source: "new",
                timestamp: timestamp(),
              });
              console.log(`  ✓ ${envVar} = ${maskValue(value)}`);
            }
          }
        }
      } catch (parseErr) {
        console.log(`  Could not parse agent output as JSON. Raw output saved.`);
      }
    }

    // Save raw output as reference
    const rawFile = path.join(OUTPUT_DIR, `${service.id}_raw.txt`);
    fs.writeFileSync(rawFile, `# ${service.name} — Agent Output\n# ${timestamp()}\n\n${finalResult}`);
    console.log(`  Raw output saved to: ${rawFile}`);

  } catch (err: any) {
    console.error(`  Error collecting ${service.name}: ${err.message}`);
  }

  return collected;
}

// ─── Output Writer ──────────────────────────────────────────────

function writeCredentialsFile(allCredentials: CollectedCredential[]): void {
  ensureOutputDir();

  const lines: string[] = [
    "# ─────────────────────────────────────────────────────────────────",
    "# Collected API Credentials — DO NOT COMMIT TO GIT",
    "# Generated by scripts/hyperbrowser_collect_keys.ts",
    `# Date: ${timestamp()}`,
    "# ─────────────────────────────────────────────────────────────────",
    "",
    "# Copy these into your .env file",
    "",
  ];

  const byService = new Map<string, CollectedCredential[]>();
  for (const cred of allCredentials) {
    const existing = byService.get(cred.service) || [];
    existing.push(cred);
    byService.set(cred.service, existing);
  }

  for (const [serviceId, creds] of byService) {
    const service = SERVICES.find(s => s.id === serviceId);
    lines.push(`# ── ${service?.name ?? serviceId} ──`);
    for (const cred of creds) {
      lines.push(`${cred.envVar}=${cred.value}`);
    }
    lines.push("");
  }

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"));
  console.log(`\nCredentials written to: ${OUTPUT_FILE}`);
}

function writeReadme(allCredentials: CollectedCredential[]): void {
  ensureOutputDir();

  const lines: string[] = [
    "# API Keys Collection Report",
    "",
    `**Generated:** ${timestamp()}`,
    `**Method:** Hyperbrowser browser-use agent (automated)`,
    "",
    "## Collected Credentials",
    "",
  ];

  for (const cred of allCredentials) {
    const service = SERVICES.find(s => s.id === cred.service);
    lines.push(`### ${service?.name ?? cred.service}`);
    lines.push(`- **Env Var:** \`${cred.envVar}\``);
    lines.push(`- **Value:** ||${cred.value}||`);
    lines.push(`- **Source:** ${cred.source}`);
    lines.push(`- **Notes:** ${service?.notes ?? ""}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## Next Steps");
  lines.push("");
  lines.push("1. Copy each credential value into your `.env` file");
  lines.push("2. **NEVER** commit this file or `.env` to git");
  lines.push("3. For exchange keys (Binance/Kraken/OKX), ensure:");
  lines.push("   - Withdrawal permissions are **DISABLED**");
  lines.push("   - Only read + spot trading permissions are enabled");
  lines.push("   - IP whitelisting is configured if available");
  lines.push("4. Test each key with a simple API call before trading");
  lines.push("");

  fs.writeFileSync(README_FILE, lines.join("\n"));
  console.log(`README written to: ${README_FILE}`);
}

// ─── CLI Argument Parsing ───────────────────────────────────────

function parseArgs(): { serviceFilter?: string; dryRun: boolean; email: string } {
  const args = process.argv.slice(2);
  let serviceFilter: string | undefined;
  let dryRun = false;
  let email = "moshuprecords@gmail.com";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--service" && args[i + 1]) {
      serviceFilter = args[i + 1];
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--email" && args[i + 1]) {
      email = args[i + 1];
      i++;
    }
  }

  return { serviceFilter, dryRun, email };
}

// ─── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { serviceFilter, dryRun, email } = parseArgs();

  if (!process.env.HYPERBROWSER_API_KEY) {
    console.error("Error: HYPERBROWSER_API_KEY not set.");
    console.error("Get one at: https://app.hyperbrowser.ai/settings");
    console.error("Then: export HYPERBROWSER_API_KEY='your-key'");
    process.exit(1);
  }

  const client = new Hyperbrowser({
    apiKey: process.env.HYPERBROWSER_API_KEY,
  });

  // Filter services
  const servicesToCollect = serviceFilter
    ? SERVICES.filter(s => s.id === serviceFilter)
    : SERVICES;

  if (servicesToCollect.length === 0) {
    console.error(`Unknown service: ${serviceFilter}`);
    console.error(`Available: ${SERVICES.map(s => s.id).join(", ")}`);
    process.exit(1);
  }

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Hyperbrowser — API Key Collection Script                  ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Services: ${servicesToCollect.length} to collect`);
  console.log(`║  Google:   ${email}`);
  console.log(`║  Dry run:  ${dryRun}`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  if (dryRun) {
    console.log("\nDry run — printing task prompts only:\n");
    for (const service of servicesToCollect) {
      console.log(`\n--- ${service.name} ---`);
      console.log(`URL: ${service.apiKeyPageUrl}`);
      console.log(`Credentials: ${service.credentialsNeeded.join(", ")}`);
      console.log(`Notes: ${service.notes}`);
      console.log(`Task length: ${buildTaskForService(service, email).length} chars`);
    }
    return;
  }

  // Create a persistent session for all services
  const session = await client.sessions.create({
    acceptCookies: true,
    useStealth: true,
    screen: { width: 1920, height: 1080 },
    timeoutMinutes: Math.max(30, servicesToCollect.length * 10),
  });

  console.log(`\nSession created: ${session.id}`);
  console.log(`Live view: ${session.liveUrl}`);

  const allCredentials: CollectedCredential[] = [];

  try {
    for (const service of servicesToCollect) {
      const creds = await collectForService(client, service, email, session.id);
      allCredentials.push(...creds);

      // Brief pause between services to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    }
  } finally {
    await client.sessions.stop(session.id);
    console.log("\nSession stopped.");
  }

  // Write outputs
  if (allCredentials.length > 0) {
    writeCredentialsFile(allCredentials);
    writeReadme(allCredentials);

    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  COLLECTION COMPLETE                                       ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Credentials collected: ${allCredentials.length}`);
    console.log(`║  Output: ${OUTPUT_FILE}`);
    console.log(`║  README: ${README_FILE}`);
    console.log("╚══════════════════════════════════════════════════════════════╝");
  } else {
    console.log("\nNo credentials collected. Check the raw output files for details.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
