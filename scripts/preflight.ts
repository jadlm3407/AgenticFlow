/**
 * AgenticFlow — Preflight Check
 * Run before the hackathon demo to verify everything is configured correctly.
 * Checks wallets, balances, ARC connectivity, and MCP server reachability.
 *
 * Usage:  npm run preflight
 */

import "dotenv/config";
import { PrivateKey } from "@bsv/sdk";
import axios from "axios";

const REQUIRED_ENV = [
  "ARC_API_KEY",
  "AGENT_ID",
  "SKILLS_AGENT_WIF", "SKILLS_AGENT_ADDRESS",
  "CLIENT_AGENT_WIF", "CLIENT_AGENT_ADDRESS",
  "ENGINE_AGENT_WIF", "ENGINE_AGENT_ADDRESS",
  "TREASURY_TX_HEX",  "TREASURY_VOUT", "TREASURY_SATS",
];

let passed = 0;
let failed = 0;

function ok(msg: string)   { console.log(`  ✅  ${msg}`); passed++; }
function fail(msg: string) { console.log(`  ❌  ${msg}`); failed++; }
function warn(msg: string) { console.log(`  ⚠️   ${msg}`); }
function section(title: string) { console.log(`\n── ${title} ${"─".repeat(50 - title.length)}`); }

async function checkBalance(
  wif:     string,
  label:   string,
  minSats: number
): Promise<number> {
  try {
    const key     = PrivateKey.fromWif(wif);
    const address = key.toAddress().toString();
    const res     = await axios.get(
      `https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent`,
      { timeout: 10_000 }
    );
    const balance = (res.data as any[]).reduce((acc, u) => acc + Number(u.value), 0);
    if (balance >= minSats) {
      ok(`${label}: ${balance.toLocaleString()} sats (min: ${minSats.toLocaleString()})`);
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
  const url = `${process.env.ARC_API_URL ?? "https://arc.taal.com"}/v1/health`;
  try {
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${process.env.ARC_API_KEY}` },
    });
    if (res.ok) {
      ok(`ARC broadcaster reachable at ${process.env.ARC_API_URL}`);
    } else {
      fail(`ARC returned HTTP ${res.status} — check your ARC_API_KEY`);
    }
  } catch (err: any) {
    fail(`ARC unreachable: ${err.message}`);
  }
}

async function checkMCP(): Promise<void> {
  const url = process.env.SKILLS_MCP_URL ?? "http://localhost:3100";
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 3000);
    const res        = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    ok(`MCP server reachable at ${url}`);
  } catch (err: any) {
    if (err.name === "AbortError") {
      fail(`MCP server timeout — is skills-server running? (npm run skills-server)`);
    } else {
      warn(`MCP server not reachable at ${url} — start it before running the full system`);
    }
  }
}

async function main() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   AgenticFlow — Preflight Check          ║");
  console.log("╚══════════════════════════════════════════╝");

  // 1. Environment variables
  section("Environment Variables");
  for (const key of REQUIRED_ENV) {
    const val = process.env[key];
    if (!val || val.includes("...") || val === "your_arc_api_key_here") {
      fail(`${key} is not set or still has placeholder value`);
    } else {
      ok(`${key} is set`);
    }
  }

  // 2. Network (mainnet vs testnet)
  section("Network");
  const arcUrl = process.env.ARC_API_URL ?? "https://arc.taal.com";
  if (arcUrl.includes("testnet")) {
    warn(`Using TESTNET (${arcUrl}) — switch to mainnet for submission`);
  } else {
    ok(`Using MAINNET (${arcUrl})`);
  }

  // 3. Agent ID
  section("On-chain Identity");
  const agentId = process.env.AGENT_ID ?? "AGFLOW26";
  if (agentId.length > 16) {
    fail(`AGENT_ID "${agentId}" is too long — max 16 chars`);
  } else {
    ok(`AGENT_ID = "${agentId}" (will appear in every OP_RETURN)`);
  }

  // 4. ARC connectivity
  section("ARC Broadcaster");
  await checkARC();

  // 5. Wallet balances
  section("Wallet Balances");
  await checkBalance(process.env.CLIENT_AGENT_WIF!,  "ClientAgent", 100_000);
  await checkBalance(process.env.ENGINE_AGENT_WIF!,  "EngineAgent", 2_000_000);

  // Skills agent doesn't need initial balance — just note the address
  ok(`SkillsAgent address: ${process.env.SKILLS_AGENT_ADDRESS} (no initial balance needed)`);

  // 6. Treasury UTXO
  section("Treasury UTXO");
  const sats = Number(process.env.TREASURY_SATS ?? 0);
  const need = Number(process.env.CHAIN_COUNT ?? 20) * Number(process.env.CHAIN_FUNDING_SATS ?? 100_000);
  if (sats >= need) {
    ok(`Treasury: ${sats.toLocaleString()} sats available (need ${need.toLocaleString()})`);
  } else {
    fail(`Treasury: only ${sats.toLocaleString()} sats — need ${need.toLocaleString()} for ${process.env.CHAIN_COUNT ?? 20} chains`);
  }

  // 7. MCP server
  section("MCP Server");
  await checkMCP();

  // 8. WhatsOnChain verification link
  section("Verification Links");
  console.log(`  🔗  Engine TXs: https://whatsonchain.com/address/${process.env.ENGINE_AGENT_ADDRESS}`);
  console.log(`  🔍  Search OP_RETURN: https://whatsonchain.com (search for "${agentId}")`);

  // Summary
  console.log(`\n${"─".repeat(52)}`);
  if (failed === 0) {
    console.log(`✅  All ${passed} checks passed — system ready to launch!\n`);
    console.log(`   Run:  npm run dev\n`);
  } else {
    console.log(`❌  ${failed} check(s) failed, ${passed} passed — fix the issues above before launching.\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Preflight error:", err.message);
  process.exit(1);
});
