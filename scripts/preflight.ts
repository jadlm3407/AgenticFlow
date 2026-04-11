/**
 * AgenticFlow — Preflight Check
 * Validates wallets, balances, ARC connectivity, and MCP server.
 * Run before every demo or hackathon submission.
 *
 * Usage:  npm run preflight
 */

import "dotenv/config";
import { PrivateKey } from "@bsv/sdk";
import axios          from "axios";

const REQUIRED_ENV = [
  "ARC_API_KEY", "AGENT_ID",
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
    const network = (process.env.ARC_API_URL ?? "").includes("testnet") ? "test" : "main";
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
  const url = `${process.env.ARC_API_URL ?? "https://arc.taal.com"}/v1/policy`;
  try {
    await axios.get(url, {
      headers: { "Authorization": `Bearer ${process.env.ARC_API_KEY}` },
      timeout: 8_000,
    });
    ok(`ARC broadcaster reachable (${process.env.ARC_API_URL})`);
  } catch (err: any) {
    if (err.response?.status === 401) {
      fail(`ARC reachable but API key invalid — check ARC_API_KEY`);
    } else {
      fail(`ARC unreachable: ${err.message}`);
    }
  }
}

async function checkMCP(): Promise<void> {
  const url = `${process.env.SKILLS_MCP_URL ?? "http://localhost:3100"}/health`;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3_000);
    const res = await axios.get(url, { signal: controller.signal as any, timeout: 3_000 });
    clearTimeout(t);
    ok(`MCP server reachable — ${res.data?.standard ?? "OK"}`);
  } catch (err: any) {
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
    if (!val || val.includes("...") || val === "your_arc_api_key_here") {
      fail(`${key} is not set`);
    } else {
      ok(`${key} ✓`);
    }
  }

  sect("Network");
  const arcUrl = process.env.ARC_API_URL ?? "https://arc.taal.com";
  if (arcUrl.includes("testnet")) {
    warn(`TESTNET mode — switch ARC_API_URL to mainnet for submission`);
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
  else fail(`Treasury: ${sats.toLocaleString()} sats — need ${need.toLocaleString()}`);

  sect("MCP Server (BRC-105)");
  await checkMCP();

  sect("WhatsOnChain Verification Links");
  console.log(`  🔗  ${`https://whatsonchain.com/address/${process.env.ENGINE_AGENT_ADDRESS}`}`);
  console.log(`  🔍  OP_RETURN search: "${process.env.AGENT_ID ?? "AGFLOW26"}"`);

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
