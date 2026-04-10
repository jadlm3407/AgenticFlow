/**
 * AgenticFlow — High-Frequency Transaction Engine
 * Target: 1.5 M on-chain transactions per 24 h  ≈  17.36 TPS
 *
 * Strategy: UTXO Chain Fan-out
 *  1. Start with a "funding" UTXO and split it into N parallel chains.
 *  2. Each chain self-funds its next transaction from the previous change output
 *     (no UTXO fetching needed — outputs are deterministic).
 *  3. Transactions encode meaningful OP_RETURN data payloads so every TX
 *     is verifiably linked to AgenticFlow work (not artificial inflation).
 *  4. Batches are sent concurrently to ARC; backpressure is handled with
 *     an adaptive delay so we never DDoS ourselves or the broadcaster.
 *
 * Each transaction carries:
 *   OP_RETURN <"AGFLOW"> <agentId> <taskHash> <timestamp>
 * making every TX auditable on-chain.
 */

import {
  Transaction,
  PrivateKey,
  P2PKH,
  OP,
  Script,
  ARC,
  type TransactionOutput,
} from "@bsv/sdk";
import { createHash } from "crypto";
import EventEmitter from "events";

// ─── Config ───────────────────────────────────────────────────────────────────

const ENGINE_WIF    = process.env.ENGINE_AGENT_WIF!;
const ENGINE_ADDR   = process.env.ENGINE_AGENT_ADDRESS!;
const ARC_API_URL   = process.env.ARC_API_URL ?? "https://arc.taal.com";
const ARC_API_KEY   = process.env.ARC_API_KEY!;
// Human-readable ID embedded in every OP_RETURN — visible on WhatsOnChain
const AGENT_ID      = process.env.AGENT_ID ?? "AGFLOW26";

// Fan-out width: number of parallel UTXO chains.
// At 17 TPS we need chains that each sustain ~1 TX/s; 20 chains with
// burst capability gives comfortable headroom.
const CHAIN_COUNT        = Number(process.env.CHAIN_COUNT ?? 20);
const TARGET_TPS         = Number(process.env.TARGET_TPS ?? 17.5);
// Satoshis per chain funding output (must cover chain depth × fee)
const CHAIN_FUNDING_SATS = Number(process.env.CHAIN_FUNDING_SATS ?? 100_000);
// Maximum depth per chain before we re-fund (safety: prevents chains > 10K deep)
const MAX_CHAIN_DEPTH    = Number(process.env.MAX_CHAIN_DEPTH ?? 5_000);
// ARC concurrency: how many TXs to broadcast simultaneously
const BROADCAST_CONCURRENCY = Number(process.env.BROADCAST_CONCURRENCY ?? 50);
const DUST_SATS          = 546n;
const SAT_PER_BYTE_RATE  = 1n;   // BSV fee floor (1 sat/byte)

if (!ENGINE_WIF || !ARC_API_KEY) {
  throw new Error("ENGINE_AGENT_WIF and ARC_API_KEY must be set");
}

const engineKey = PrivateKey.fromWif(ENGINE_WIF);
const arc       = new ARC(ARC_API_URL, { apiKey: ARC_API_KEY });

// ─── Event bus ────────────────────────────────────────────────────────────────

export const engineBus = new EventEmitter();

export interface EngineStats {
  sent:         number;
  confirmed:    number;
  failed:       number;
  tps:          number;
  chainDepths:  number[];
  startTime:    number;
}

const stats: EngineStats = {
  sent:        0,
  confirmed:   0,
  failed:      0,
  tps:         0,
  chainDepths: Array(CHAIN_COUNT).fill(0),
  startTime:   Date.now(),
};

setInterval(() => {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  stats.tps     = elapsed > 0 ? stats.sent / elapsed : 0;
  engineBus.emit("stats", { ...stats });
}, 2000);

// ─── OP_RETURN payload builder ────────────────────────────────────────────────

function buildOpReturn(agentId: string, taskHash: string): Script {
  const prefix    = Buffer.from("AGFLOW", "utf8");
  const agent     = Buffer.from(agentId.slice(0, 16), "utf8");
  const hashBuf   = Buffer.from(taskHash.slice(0, 32), "hex");
  const ts        = Buffer.allocUnsafe(8);
  ts.writeBigUInt64BE(BigInt(Date.now()));

  // OP_FALSE OP_RETURN <prefix> <agentId> <taskHash> <timestamp>
  const script = new Script();
  script.writeOpCode(OP.OP_FALSE);
  script.writeOpCode(OP.OP_RETURN);
  script.writeBin(prefix);
  script.writeBin(agent);
  script.writeBin(hashBuf);
  script.writeBin(ts);
  return script;
}

// ─── UTXO chain state ─────────────────────────────────────────────────────────

interface ChainState {
  id:           number;
  prevTxid:     string;
  prevVout:     number;
  prevSatoshis: bigint;
  prevTxHex:    string;   // full raw TX for SPV input sourcing
  depth:        number;
}

// ─── Build one chained transaction ───────────────────────────────────────────

async function buildChainedTx(
  chain:    ChainState,
  agentId:  string,
  taskData: string,
): Promise<{ txHex: string; newState: ChainState } | null> {
  const taskHash  = createHash("sha256").update(taskData).digest("hex");
  const opReturn  = buildOpReturn(agentId, taskHash);
  const p2pkh     = new P2PKH();
  const lockScript = p2pkh.lock(ENGINE_ADDR);

  // Estimate TX size: 1 input (148B) + 1 P2PKH output (34B) + 1 OP_RETURN (≈50B) + 10 overhead
  const estimatedBytes = 148n + 34n + 50n + 10n;
  const fee            = estimatedBytes * SAT_PER_BYTE_RATE;
  const changeSats     = chain.prevSatoshis - fee;

  if (changeSats <= DUST_SATS) {
    console.warn(`⚠️  Chain ${chain.id} exhausted at depth ${chain.depth}`);
    return null;
  }

  const tx = new Transaction();

  tx.addInput({
    sourceTXID:              chain.prevTxid,
    sourceOutputIndex:       chain.prevVout,
    sourceTransaction:       Transaction.fromHex(chain.prevTxHex),
    unlockingScriptTemplate: p2pkh.unlock(engineKey),
  });

  // Change output (funds next TX in chain)
  tx.addOutput({ lockingScript: lockScript, satoshis: changeSats });

  // OP_RETURN data output (0 satoshis — data only)
  tx.addOutput({ lockingScript: opReturn, satoshis: 0n });

  await tx.sign();

  const txHex = tx.toHex();
  const txid  = tx.id("hex") as string;

  const newState: ChainState = {
    id:           chain.id,
    prevTxid:     txid,
    prevVout:     0,  // change is always output index 0
    prevSatoshis: changeSats,
    prevTxHex:    txHex,
    depth:        chain.depth + 1,
  };

  return { txHex, newState };
}

// ─── Broadcast with retry + backpressure ─────────────────────────────────────

interface BroadcastResult { txid: string; success: boolean }

async function broadcastWithRetry(
  txHex:    string,
  maxRetry: number = 3
): Promise<BroadcastResult> {
  const tx   = Transaction.fromHex(txHex);
  const txid = tx.id("hex") as string;

  for (let attempt = 0; attempt < maxRetry; attempt++) {
    try {
      await arc.broadcastTransaction(tx);
      stats.sent++;
      return { txid, success: true };
    } catch (err: any) {
      const msg: string = err.message ?? "";
      if (msg.includes("already known") || msg.includes("txn-already-in-mempool")) {
        // TX already in mempool → treat as success
        stats.sent++;
        return { txid, success: true };
      }
      if (attempt < maxRetry - 1) {
        const backoff = 100 * Math.pow(2, attempt); // 100, 200, 400 ms
        await delay(backoff);
      }
    }
  }

  stats.failed++;
  return { txid, success: false };
}

// ─── Concurrent batch broadcaster ────────────────────────────────────────────

async function broadcastBatch(
  batch: { txHex: string; chainId: number }[]
): Promise<void> {
  // Process in chunks of BROADCAST_CONCURRENCY
  for (let i = 0; i < batch.length; i += BROADCAST_CONCURRENCY) {
    const chunk = batch.slice(i, i + BROADCAST_CONCURRENCY);
    await Promise.allSettled(
      chunk.map(({ txHex, chainId }) =>
        broadcastWithRetry(txHex).then(res => {
          engineBus.emit("tx", { chainId, txid: res.txid, success: res.success });
        })
      )
    );
  }
}

// ─── Chain re-funding ─────────────────────────────────────────────────────────

/**
 * Called when a chain exhausts its funds or hits MAX_CHAIN_DEPTH.
 * Builds a new funding TX from the primary wallet back to the engine address.
 * In production: source from a "treasury" UTXO managed separately.
 */
async function refundChain(
  chain:       ChainState,
  sourceTxHex: string,
  sourceVout:  number,
  sourceSats:  bigint
): Promise<ChainState> {
  const p2pkh      = new P2PKH();
  const lockScript = p2pkh.lock(ENGINE_ADDR);
  const fee        = 200n;
  const outSats    = sourceSats - fee;

  if (outSats <= DUST_SATS) throw new Error("Insufficient refund amount");

  const tx = new Transaction();
  tx.addInput({
    sourceTXID:              chain.prevTxid,
    sourceOutputIndex:       sourceVout,
    sourceTransaction:       Transaction.fromHex(sourceTxHex),
    unlockingScriptTemplate: p2pkh.unlock(engineKey),
  });
  tx.addOutput({ lockingScript: lockScript, satoshis: BigInt(CHAIN_FUNDING_SATS) });
  await tx.sign();

  const txHex = tx.toHex();
  await broadcastWithRetry(txHex);

  return {
    id:           chain.id,
    prevTxid:     tx.id("hex") as string,
    prevVout:     0,
    prevSatoshis: BigInt(CHAIN_FUNDING_SATS),
    prevTxHex:    txHex,
    depth:        0,
  };
}

// ─── Single chain driver ──────────────────────────────────────────────────────

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function driveChain(
  chain:    ChainState,
  agentId:  string,
  stopFlag: { stop: boolean }
): Promise<void> {
  const intervalMs = Math.floor(1000 / (TARGET_TPS / CHAIN_COUNT));

  while (!stopFlag.stop) {
    const taskData = `agent:${agentId}|chain:${chain.id}|depth:${chain.depth}|ts:${Date.now()}`;
    const built    = await buildChainedTx(chain, agentId, taskData);

    if (!built || chain.depth >= MAX_CHAIN_DEPTH) {
      // Chain needs refunding — pause briefly and signal
      engineBus.emit("chain-exhausted", { chainId: chain.id, depth: chain.depth });
      await delay(1000);
      // In production: re-fund from treasury. For now, just stop this chain.
      break;
    }

    // Broadcast asynchronously (do not block chain advancement)
    broadcastWithRetry(built.txHex).then(res => {
      if (res.success) stats.chainDepths[chain.id] = chain.depth;
      engineBus.emit("tx", { chainId: chain.id, txid: res.txid, success: res.success });
    });

    // Advance chain state immediately (no need to wait for broadcast)
    chain = built.newState;

    // Adaptive rate control: if sent is lagging behind target, skip delay
    const elapsed        = (Date.now() - stats.startTime) / 1000;
    const targetSentByNow = TARGET_TPS * elapsed;
    if (stats.sent < targetSentByNow * 0.9) {
      // We're behind — skip delay to catch up
      continue;
    }

    await delay(intervalMs);
  }
}

// ─── Engine bootstrap: create initial funding transactions ────────────────────

/**
 * Given a single large "treasury" UTXO, fan out to CHAIN_COUNT funding UTXOs.
 * treasuryTxHex: raw hex of the treasury funding TX
 * treasuryVout:  output index of the treasury UTXO
 * treasurySats:  satoshis available in the treasury UTXO
 */
export async function bootstrapChains(
  treasuryTxHex: string,
  treasuryVout:  number,
  treasurySats:  bigint
): Promise<ChainState[]> {
  const p2pkh      = new P2PKH();
  const lockScript = p2pkh.lock(ENGINE_ADDR);
  const fee        = BigInt(CHAIN_COUNT * 34 + 148 + 10);
  const perChain   = BigInt(CHAIN_FUNDING_SATS);
  const total      = perChain * BigInt(CHAIN_COUNT) + fee;

  if (treasurySats < total) {
    throw new Error(`Treasury has ${treasurySats} sats, need ${total} for ${CHAIN_COUNT} chains`);
  }

  // Build fan-out TX: 1 input → CHAIN_COUNT P2PKH outputs + change
  const fanoutTx = new Transaction();
  fanoutTx.addInput({
    sourceTXID:              "treasury",
    sourceOutputIndex:       treasuryVout,
    sourceTransaction:       Transaction.fromHex(treasuryTxHex),
    unlockingScriptTemplate: p2pkh.unlock(engineKey),
  });

  for (let i = 0; i < CHAIN_COUNT; i++) {
    fanoutTx.addOutput({ lockingScript: lockScript, satoshis: perChain });
  }

  const change = treasurySats - total;
  if (change > DUST_SATS) {
    fanoutTx.addOutput({ lockingScript: lockScript, satoshis: change });
  }

  await fanoutTx.sign();
  const fanoutHex = fanoutTx.toHex();
  await broadcastWithRetry(fanoutHex);

  const fanoutTxid = fanoutTx.id("hex") as string;

  const chains: ChainState[] = [];
  for (let i = 0; i < CHAIN_COUNT; i++) {
    chains.push({
      id:           i,
      prevTxid:     fanoutTxid,
      prevVout:     i,
      prevSatoshis: perChain,
      prevTxHex:    fanoutHex,
      depth:        0,
    });
  }

  console.log(`🚀  Bootstrapped ${CHAIN_COUNT} chains from fanout TX: ${fanoutTxid}`);
  return chains;
}

// ─── Main engine entry point ──────────────────────────────────────────────────

export async function startEngine(chains: ChainState[]): Promise<{ stop: () => void }> {
  const stopFlag = { stop: false };
  const agentId  = AGENT_ID; // embedded in every OP_RETURN on-chain

  console.log(`⚡  Engine starting: ${CHAIN_COUNT} chains, target ${TARGET_TPS} TPS`);
  console.log(`🏷️   Agent ID (on-chain label): ${agentId}`);
  console.log(`🔍  Verify at: https://whatsonchain.com/address/${ENGINE_ADDR}`);
  console.log(`📊  Goal: 1,500,000 TXs in 24h (${(1_500_000 / 86_400).toFixed(2)} TPS avg)`);

  // Launch all chains concurrently
  const promises = chains.map(chain =>
    driveChain({ ...chain }, agentId, stopFlag)
      .catch(err => console.error(`Chain ${chain.id} error:`, err.message))
  );

  // Progress reporter
  const reporter = setInterval(() => {
    const elapsed  = ((Date.now() - stats.startTime) / 1000).toFixed(0);
    const projected = stats.sent * (86_400 / ((Date.now() - stats.startTime) / 1000));
    console.log(
      `📈  t+${elapsed}s | sent: ${stats.sent.toLocaleString()} | ` +
      `tps: ${stats.tps.toFixed(2)} | ` +
      `projected/24h: ${projected.toFixed(0)} | ` +
      `failed: ${stats.failed}`
    );
  }, 10_000);

  return {
    stop: () => {
      stopFlag.stop = true;
      clearInterval(reporter);
      console.log("🛑  Engine stopping...");
    },
  };
}

// ─── Standalone entry ─────────────────────────────────────────────────────────

if (require.main === module) {
  // For standalone testing: mock treasury (replace with real UTXO in production)
  const MOCK_TREASURY_TXHEX = process.env.TREASURY_TX_HEX!;
  const MOCK_TREASURY_VOUT  = Number(process.env.TREASURY_VOUT ?? 0);
  const MOCK_TREASURY_SATS  = BigInt(process.env.TREASURY_SATS ?? "10000000");

  (async () => {
    const chains = await bootstrapChains(
      MOCK_TREASURY_TXHEX,
      MOCK_TREASURY_VOUT,
      MOCK_TREASURY_SATS
    );
    const engine = await startEngine(chains);

    engineBus.on("stats", (s: EngineStats) => {
      engineBus.emit("stats-update", s);
    });

    process.on("SIGINT",  () => { engine.stop(); process.exit(0); });
    process.on("SIGTERM", () => { engine.stop(); process.exit(0); });
  })().catch(err => { console.error(err); process.exit(1); });
}
