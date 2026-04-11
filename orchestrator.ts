/**
 * AgenticFlow — Autonomous Orchestrator
 *
 * Wires together three BRC-100/105 compliant agents:
 *   - SkillsAgent  (MCP server, tool seller, BRC-105 payee)
 *   - ClientAgent  (autonomous buyer, BRC-105 payer)
 *   - EngineAgent  (high-frequency TX engine, UTXO chain fan-out)
 *
 * Uses @bsv/wallet-toolbox patterns for wallet health checks.
 * 100% autonomous after launch — no human triggers.
 */

import "dotenv/config";
import { spawn, ChildProcess }  from "child_process";
import path                     from "path";
import axios                    from "axios";
import { PrivateKey }           from "@bsv/sdk";
import { startClientAgent, stopClientAgent, agentBus } from "./agents/client-agent";
import { bootstrapChains, startEngine, engineBus }     from "./engine/tx-engine";

// ─── Config validation ────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "SKILLS_AGENT_WIF", "SKILLS_AGENT_ADDRESS",
  "CLIENT_AGENT_WIF", "CLIENT_AGENT_ADDRESS",
  "ENGINE_AGENT_WIF", "ENGINE_AGENT_ADDRESS",
  "ARC_API_KEY",
  "TREASURY_TX_HEX",  "TREASURY_VOUT", "TREASURY_SATS",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌  Missing required env var: ${key}`);
    process.exit(1);
  }
}

const ARC_URL = process.env.ARC_API_URL ?? "https://arc.taal.com";

// ─── BRC-100 wallet health check (via WhatsOnChain) ──────────────────────────

async function checkWalletBalance(wif: string, label: string): Promise<number> {
  try {
    const key     = PrivateKey.fromWif(wif);
    const address = key.toAddress().toString();
    const network = ARC_URL.includes("testnet") ? "test" : "main";
    const res     = await axios.get(
      `https://api.whatsonchain.com/v1/bsv/${network}/address/${address}/unspent`,
      { timeout: 10_000 }
    );
    const total = (res.data as any[]).reduce((acc, u) => acc + Number(u.value), 0);
    console.log(`💳  [${label}] ${address}`);
    console.log(`    Balance: ${total.toLocaleString()} sats`);
    return total;
  } catch (err: any) {
    console.warn(`⚠️  [${label}] Could not fetch balance: ${err.message}`);
    return 0;
  }
}

// ─── SkillsAgent subprocess (with auto-restart) ───────────────────────────────

function spawnSkillsAgent(): ChildProcess {
  const serverPath = path.resolve(__dirname, "agents", "skills-server.ts");
  const proc = spawn("npx", ["ts-node", "--transpile-only", serverPath], {
    env:   process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (d: Buffer) =>
    process.stdout.write(`[SkillsAgent] ${d}`)
  );
  proc.stderr?.on("data", (d: Buffer) =>
    process.stderr.write(`[SkillsAgent:ERR] ${d}`)
  );
  proc.on("exit", code => {
    if (code !== 0 && code !== null) {
      console.error(`💥  SkillsAgent exited (code ${code}). Restarting in 5s…`);
      setTimeout(spawnSkillsAgent, 5_000);
    }
  });

  return proc;
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────

function startWatchdog(getStats: () => { sent: number; failed: number }): NodeJS.Timeout {
  let lastSent   = 0;
  let lastTxAt   = Date.now();
  let stalePings = 0;

  return setInterval(() => {
    const { sent } = getStats();
    if (sent > lastSent) {
      lastTxAt   = Date.now();
      stalePings = 0;
    } else {
      stalePings++;
      const staleSec = Math.round((Date.now() - lastTxAt) / 1000);
      console.warn(`⚠️  Watchdog: no new TXs for ${staleSec}s (ping ${stalePings}/3)`);
      if (stalePings >= 3) {
        engineBus.emit("stall-detected", { staleSec });
        stalePings = 0;
      }
    }
    lastSent = sent;
  }, 30_000);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   AgenticFlow · BRC-100/105 · Autonomous    ║");
  console.log("║   Open Run Agentic Pay 2026                 ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const network = ARC_URL.includes("testnet") ? "🟡 TESTNET" : "🟢 MAINNET";
  console.log(`🌐  Network: ${network} (${ARC_URL})\n`);

  // 1. Wallet health checks (BRC-100 wallet pattern)
  console.log("── Wallet Balances ────────────────────────────────");
  await Promise.all([
    checkWalletBalance(process.env.CLIENT_AGENT_WIF!,  "ClientAgent"),
    checkWalletBalance(process.env.ENGINE_AGENT_WIF!,  "EngineAgent"),
    checkWalletBalance(process.env.SKILLS_AGENT_WIF!,  "SkillsAgent"),
  ]);

  // 2. Bootstrap UTXO chains
  console.log("\n── UTXO Fan-out ────────────────────────────────────");
  const chains = await bootstrapChains(
    process.env.TREASURY_TX_HEX!,
    Number(process.env.TREASURY_VOUT),
    BigInt(process.env.TREASURY_SATS!)
  );
  console.log(`✅  ${chains.length} chains bootstrapped\n`);

  // 3. Start SkillsAgent MCP server (BRC-105 payee)
  console.log("── Starting SkillsAgent (BRC-105 server) ──────────");
  const mcpProc = spawnSkillsAgent();
  await new Promise(r => setTimeout(r, 2_000)); // wait for port to bind

  // 4. Start ClientAgent autonomous loop (BRC-105 payer)
  console.log("── Starting ClientAgent (BRC-105 client) ──────────");
  const clientHandle = startClientAgent();

  // 5. Start TX Engine
  console.log("── Starting TX Engine (UTXO chains) ───────────────");
  const engine = await startEngine(chains);

  // 6. Watchdog
  let liveStats = { sent: 0, failed: 0, tps: 0, startTime: Date.now() };
  engineBus.on("stats", (s: any) => { liveStats = s; });
  const watchdog = startWatchdog(() => liveStats);

  // 7. Summary every 60 s
  const summaryTimer = setInterval(() => {
    const mins    = ((Date.now() - liveStats.startTime) / 60_000).toFixed(1);
    const failPct = liveStats.sent > 0
      ? ((liveStats.failed / liveStats.sent) * 100).toFixed(2) : "0.00";
    console.log(
      `📊  t+${mins}min | sent: ${liveStats.sent.toLocaleString()} | ` +
      `tps: ${liveStats.tps?.toFixed(2) ?? "0.00"} | fail%: ${failPct}`
    );
  }, 60_000);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n🛑  Shutting down AgenticFlow…");
    stopClientAgent(clientHandle);
    engine.stop();
    clearInterval(watchdog);
    clearInterval(summaryTimer);
    mcpProc.kill("SIGTERM");
    setTimeout(() => process.exit(0), 3_000);
  };

  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);

  console.log("\n✅  All systems autonomous. No human interaction required.");
  console.log(`🔍  Verify TXs: https://whatsonchain.com/address/${process.env.ENGINE_AGENT_ADDRESS}\n`);
}

main().catch(err => {
  console.error("💥  Fatal:", err.message);
  process.exit(1);
});
