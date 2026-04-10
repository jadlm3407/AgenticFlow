/**
 * AgenticFlow — Autonomous Orchestrator
 * Single entry point that wires all agents together and starts the
 * autonomous payment loop with ZERO human triggers after launch.
 *
 * Boot sequence:
 *  1. Verify wallet balances on both agents
 *  2. Fan-out treasury UTXO to N engine chains
 *  3. Start Skills Agent MCP server
 *  4. Start Client Agent negotiation loop
 *  5. Start High-Frequency TX Engine
 *  6. Health-check watchdog with auto-recovery
 */

import "dotenv/config";
import { spawn, ChildProcess }              from "child_process";
import path                                 from "path";
import axios from "axios";
import { PrivateKey }                       from "@bsv/sdk";
import { startClientAgent, stopClientAgent, agentBus } from "./agents/client-agent";
import { bootstrapChains, startEngine, engineBus }     from "./engine/tx-engine";

// ─── Config validation ────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "SKILLS_AGENT_WIF",
  "SKILLS_AGENT_ADDRESS",
  "CLIENT_AGENT_WIF",
  "CLIENT_AGENT_ADDRESS",
  "ENGINE_AGENT_WIF",
  "ENGINE_AGENT_ADDRESS",
  "ARC_API_KEY",
  "TREASURY_TX_HEX",
  "TREASURY_VOUT",
  "TREASURY_SATS",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌  Missing required env var: ${key}`);
    process.exit(1);
  }
}

const ARC_URL = process.env.ARC_API_URL ?? "https://arc.taal.com";

// ─── Wallet health check ──────────────────────────────────────────────────────

async function checkWalletBalance(wif: string, label: string): Promise<number> {
  try {
    const key     = PrivateKey.fromWif(wif);
    const address = key.toAddress().toString();
    const res     = await axios.get(
      `https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent`,
      { timeout: 10_000 }
    );
    const total = (res.data as any[]).reduce((acc, u) => acc + Number(u.value), 0);
    console.log(`💳  [${label}] Balance: ${total.toLocaleString()} satoshis (${address})`);
    return total;
  } catch (err: any) {
    console.warn(`⚠️  [${label}] Could not fetch balance: ${err.message}`);
    return 0;
  }
}

// ─── MCP Server subprocess ────────────────────────────────────────────────────

function spawnMcpServer(): ChildProcess {
  const serverPath = path.resolve(__dirname, "agents", "skills-server.ts");
  const proc = spawn("npx", ["ts-node", "--transpile-only", serverPath], {
    env:   process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (d: Buffer) =>
    process.stdout.write(`[SkillsAgent] ${d.toString()}`)
  );
  proc.stderr?.on("data", (d: Buffer) =>
    process.stderr.write(`[SkillsAgent:ERR] ${d.toString()}`)
  );

  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`💥  SkillsAgent exited with code ${code}. Restarting in 5s…`);
      setTimeout(() => spawnMcpServer(), 5000);
    }
  });

  return proc;
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────

interface WatchdogState {
  lastTxAt:       number;
  totalSent:      number;
  consecutiveFails: number;
}

function startWatchdog(
  getStats: () => { sent: number; failed: number }
): NodeJS.Timeout {
  const state: WatchdogState = {
    lastTxAt:         Date.now(),
    totalSent:        0,
    consecutiveFails: 0,
  };

  return setInterval(() => {
    const { sent, failed } = getStats();
    const newSent = sent - state.totalSent;

    if (newSent > 0) {
      state.lastTxAt         = Date.now();
      state.consecutiveFails = 0;
    } else {
      const staleSec = Math.round((Date.now() - state.lastTxAt) / 1000);
      console.warn(`⚠️  Watchdog: no new TXs for ${staleSec}s`);
      state.consecutiveFails++;
    }

    if (state.consecutiveFails >= 3) {
      console.error("🚨  Engine appears stalled. Alerting operators.");
      // In production: trigger PagerDuty / re-bootstrap chains
      engineBus.emit("stall-detected", { staleSec: (Date.now() - state.lastTxAt) / 1000 });
      state.consecutiveFails = 0;
    }

    state.totalSent = sent;
  }, 30_000); // check every 30 s
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   AgenticFlow · Autonomous Boot      ║");
  console.log("║   Open Run Agentic Pay 2026          ║");
  console.log("╚══════════════════════════════════════╝\n");

  // 1. Wallet health
  await Promise.all([
    checkWalletBalance(process.env.CLIENT_AGENT_WIF!,  "ClientAgent"),
    checkWalletBalance(process.env.ENGINE_AGENT_WIF!,  "EngineAgent"),
    checkWalletBalance(process.env.SKILLS_AGENT_WIF!,  "SkillsAgent"),
  ]);

  // 2. Bootstrap UTXO chains
  console.log("\n🔗  Bootstrapping UTXO fan-out chains…");
  const chains = await bootstrapChains(
    process.env.TREASURY_TX_HEX!,
    Number(process.env.TREASURY_VOUT),
    BigInt(process.env.TREASURY_SATS!)
  );
  console.log(`✅  ${chains.length} chains ready\n`);

  // 3. Start MCP server (subprocess)
  console.log("🌐  Starting SkillsAgent MCP server…");
  const mcpProc = spawnMcpServer();
  await new Promise(r => setTimeout(r, 2000)); // wait for server to bind

  // 4. Start client agent
  console.log("🤖  Starting ClientAgent autonomous loop…");
  const clientHandle = startClientAgent();

  // 5. Start TX engine
  console.log("⚡  Starting TX engine…");
  const engine = await startEngine(chains);

  // 6. Watchdog
  let lastStats = { sent: 0, failed: 0 };
  engineBus.on("stats", (s: any) => { lastStats = s; });
  const watchdog = startWatchdog(() => lastStats);

  // 7. Log summary every minute
  const summaryTimer = setInterval(() => {
    const elapsed  = ((Date.now() - lastStats.startTime ?? Date.now()) / 60_000).toFixed(1);
    const failRate = lastStats.sent > 0
      ? ((lastStats.failed / lastStats.sent) * 100).toFixed(2)
      : "0.00";
    console.log(`📊  Summary | +${elapsed}min | sent: ${lastStats.sent.toLocaleString()} | tps: ${lastStats.tps?.toFixed(2)} | fail%: ${failRate}`);
  }, 60_000);

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  const shutdown = () => {
    console.log("\n🛑  Shutting down AgenticFlow…");
    stopClientAgent(clientHandle);
    engine.stop();
    clearInterval(watchdog);
    clearInterval(summaryTimer);
    mcpProc.kill("SIGTERM");
    setTimeout(() => process.exit(0), 3000);
  };

  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);

  console.log("\n✅  All systems autonomous. No human interaction required.");
  console.log("   Press Ctrl+C to stop gracefully.\n");
}

main().catch(err => {
  console.error("💥  Fatal orchestrator error:", err);
  process.exit(1);
});
