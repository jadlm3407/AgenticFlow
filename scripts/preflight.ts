/**
 * AgenticFlow — Preflight Check
 * Compatible with GorillaPool ARC (no API key) and TAAL ARC.
 *
 * Usage:  npm run preflight
 */

import "dotenv/config";
import { PrivateKey } from "@bsv/sdk";
import axios          from "axios";

const REQUIRED_ENV = [
  "AGENT_ID",
  "SKILLS_AGENT_WIF", "SKILLS_AGENT_ADDRESS",
  "CLIENT_AGENT_WIF", "CLIENT_AGENT_ADDRESS",
  "ENGINE_AGENT_WIF", "ENGINE_AGENT_ADDRESS",
  "TREASURY_TX_HEX",  "TREASURY_VOUT", "TREASURY_SATS",
];

let passed = 0;
let failed = 0;

const ok   = (msg: string) => { console.log(`  ✅  ${msg}`); passed++; };
const fail = (msg: string) => { console.log(`  ❌  ${msg}`); failed++; };
const warn = (msg: string) =>   console.log(`  ⚠️   ${msg}`);
const sect = (t: string)   =>   console.log(`\n── ${t} ${"─".repeat(Math.max(0, 48 - t.length))}`);

async function checkBalance(wif: string, label: string, minSats: number): Promise<number> {
  try {
    const key     = PrivateKey.fromWif(wif);
    const address = key.toAddress().toString();
    const network = (process.env.ARC_API_URL ?? "").includes("test") ? "test" : "main";
    const res     = await axios.get(
      `https://api.whatsonchain.com/v1/bsv/${network}/address/${address}/unspent`,
      { timeout: 10_000 }
    );
    const balance = (res.data as any[]).reduce((acc, u) => acc + Number(u.value), 0);
    if (balance >= minSats) {
      ok(`${label}: ${balance.toLocaleString()} sats ✓`);
    } else {
      fail(`${label}: only ${balance.toLocaleString()} sats — need ≥ ${minSats.toLocaleString()}`);
    }
    return balance;
  } catch (err: any) {
    fail(`${label}: could not fetch balance — ${err.message}`);
    return 0;
  }
}

async function checkARC(): Promise<void> {
  const arcUrl    = process.env.ARC_API_URL ?? "https://arc.gorillapool.io";
  const arcKey    = process.env.ARC_API_KEY ?? "none";
  const url       = `${arcUrl}/v1/policy`;

  const headers: Record<string, string> = {};
  if (arcKey && arcKey !== "none") {
    headers["Authorization"] = `Bearer ${arcKey}`;
  }

  try {
    await axios.get(url, { headers, timeout: 8_000 });
    ok(`ARC reachable — ${arcUrl} ${arcKey === "none" ? "(no key — GorillaPool)" : "(with API key)"}`);
  } catch (err: any) {
    if (err.response?.status === 401) {
      fail(`ARC reachable but API key invalid — check ARC_API_KEY`);
    } else if (err.response?.status === 404) {
      // Some ARC nodes return 404 on /policy but are still functional
      ok(`ARC reachable — ${arcUrl} (policy endpoint not exposed, OK)`);
    } else {
      fail(`ARC unreachable at ${arcUrl}: ${err.message}`);
    }
  }
}

async function checkMCP(): Promise<void> {
  const url = `${process.env.SKILLS_MCP_URL ?? "http://localhost:3100"}/health`;
  try {
    const res = await axios.get(url, { timeout: 3_000 });
    ok(`MCP server reachable — ${res.data?.standard ?? "OK"}`);
  } catch {
    warn(`MCP server not running yet — start with: npm run skills-server`);
  }
}

async function main() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   AgenticFlow — Preflight Check          ║");
  console.log("╚══════════════════════════════════════════╝");

  sect("Environment Variables");
  for (const key of REQUIRED_ENV) {
    const val = process.env[key];
    if (!val || val.includes("...")) {
      fail(`${key} is not set`);
    } else {
      ok(`${key} ✓`);
    }
  }
  // ARC_API_KEY is optional (GorillaPool doesn't need one)
  const arcKey = process.env.ARC_API_KEY ?? "none";
  if (arcKey === "none" || arcKey === "") {
    ok(`ARC_API_KEY = "none" (GorillaPool mode — no key needed) ✓`);
  } else {
    ok(`ARC_API_KEY ✓`);
  }

  sect("Network");
  const arcUrl = process.env.ARC_API_URL ?? "https://arc.gorillapool.io";
  if (arcUrl.includes("test")) {
    warn(`TESTNET mode — switch to mainnet for submission`);
  } else {
    ok(`MAINNET (${arcUrl})`);
  }

  sect("Agent ID (on-chain label)");
  const agentId = process.env.AGENT_ID ?? "";
  if (agentId.length > 16) fail(`AGENT_ID too long — max 16 chars`);
  else ok(`AGENT_ID = "${agentId}"`);

  sect("ARC Broadcaster");
  await checkARC();

  sect("Wallet Balances (BRC-100)");
  await checkBalance(process.env.CLIENT_AGENT_WIF!,  "ClientAgent", 10_000);
  await checkBalance(process.env.ENGINE_AGENT_WIF!,  "EngineAgent", 30_000);
  ok(`SkillsAgent — no initial balance needed`);

  sect("Treasury UTXO");
  const sats = Number(process.env.TREASURY_SATS ?? 0);
  const need = Number(process.env.CHAIN_COUNT ?? 3) * Number(process.env.CHAIN_FUNDING_SATS ?? 10_000);
  if (sats >= need) ok(`Treasury: ${sats.toLocaleString()} sats (need ${need.toLocaleString()})`);
  else fail(`Treasury: ${sats.toLocaleString()} sats — need at least ${need.toLocaleString()}`);

  sect("MCP Server (BRC-105)");
  await checkMCP();

  sect("WhatsOnChain Verification Links");
  console.log(`  🔗  https://whatsonchain.com/address/${process.env.ENGINE_AGENT_ADDRESS ?? "not set"}`);
  console.log(`  🔍  OP_RETURN search: "${agentId}"`);

  console.log(`\n${"─".repeat(52)}`);
  if (failed === 0) {
    console.log(`\n✅  All ${passed} checks passed — ready to launch!\n`);
    console.log(`   npm run dev\n`);
  } else {
    console.log(`\n❌  ${failed} check(s) failed — fix them before launching.\n`);
    process.exit(1);
  }
}

main().catch(err => { console.error("Preflight error:", err.message); process.exit(1); });