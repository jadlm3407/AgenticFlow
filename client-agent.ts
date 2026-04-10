/**
 * AgenticFlow — Client Agent (Buyer)
 * Autonomously discovers the Skills Agent via MCP, negotiates price,
 * builds and signs a BSV micropayment transaction, then consumes the skill.
 *
 * Fully autonomous: runs on a self-scheduling loop with no human triggers.
 * Uses @bsv/sdk for raw TX construction and @bsv/simple for UTXO management.
 */

import { Client as McpClient } from "@bsv/simple-mcp";
import { SimpleSPV, SimpleWallet } from "@bsv/simple";
import {
  Transaction,
  PrivateKey,
  P2PKH,
  ARC,
  MerklePath,
  type TransactionInput,
} from "@bsv/sdk";
import EventEmitter from "events";

// ─── Config ───────────────────────────────────────────────────────────────────

const CLIENT_WIF        = process.env.CLIENT_AGENT_WIF!;
const CLIENT_ADDRESS    = process.env.CLIENT_AGENT_ADDRESS!;
const ARC_API_URL       = process.env.ARC_API_URL ?? "https://arc.taal.com";
const ARC_API_KEY       = process.env.ARC_API_KEY!;
const SKILLS_MCP_URL    = process.env.SKILLS_MCP_URL ?? "http://localhost:3100";
const MAX_PRICE_SATS    = Number(process.env.MAX_PRICE_SATS ?? 500);
const MIN_BALANCE_SATS  = Number(process.env.MIN_BALANCE_SATS ?? 5_000);
// Tasks to cycle through autonomously
const TASK_QUEUE = [
  { tool: "sentiment_analysis", payload: { text: "BSV is the best blockchain for enterprise data." } },
  { tool: "classify_intent",    payload: { text: "Please send 100 satoshis to Alice." } },
  { tool: "summarise_text",     payload: { text: "Bitcoin SV (BSV) is a cryptocurrency that was created as a hard fork of Bitcoin Cash (BCH) in November 2018. BSV aims to fulfil the original vision of Bitcoin as described in the Bitcoin whitepaper by Satoshi Nakamoto, focusing on scalability, stability, and security. It supports large block sizes to enable more transactions per second on-chain." } },
  { tool: "translate_text",     payload: { text: "Hello, world!", target_lang: "es" } },
];

if (!CLIENT_WIF || !ARC_API_KEY) {
  console.error("❌  CLIENT_AGENT_WIF and ARC_API_KEY must be set.");
  process.exit(1);
}

// ─── Event bus (consumed by tx-engine and UI) ─────────────────────────────────

export const agentBus = new EventEmitter();

export interface NegotiationEvent {
  type:      "discovered" | "negotiated" | "paid" | "executed" | "rejected" | "error";
  timestamp: string;
  tool:      string;
  price?:    number;
  txid?:     string;
  result?:   unknown;
  reason?:   string;
}

function emit(event: NegotiationEvent) {
  agentBus.emit("event", event);
  const icon = { discovered:"🔍", negotiated:"🤝", paid:"💸", executed:"✅", rejected:"❌", error:"💥" }[event.type];
  console.log(`${icon}  [${event.timestamp}] ${event.type.toUpperCase()} — ${event.tool}`, event.txid ?? event.reason ?? "");
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

const clientKey  = PrivateKey.fromWif(CLIENT_WIF);
const arc        = new ARC(ARC_API_URL, { apiKey: ARC_API_KEY });
const wallet     = new SimpleWallet({ privateKey: clientKey, arcUrl: ARC_API_URL, apiKey: ARC_API_KEY });
const spv        = new SimpleSPV({ arcUrl: ARC_API_URL, apiKey: ARC_API_KEY });

// ─── UTXO cache ───────────────────────────────────────────────────────────────

interface UTXO {
  txid:      string;
  vout:      number;
  satoshis:  bigint;
  script:    string;   // hex locking script
  txHex?:    string;   // full tx for SPV proof
}

let utxoCache: UTXO[]  = [];
let cacheAge: number   = 0;
const CACHE_TTL_MS     = 15_000; // refresh every 15 s

async function refreshUTXOs(): Promise<UTXO[]> {
  if (Date.now() - cacheAge < CACHE_TTL_MS && utxoCache.length > 0) return utxoCache;
  try {
    const raw = await wallet.listUnspent();
    utxoCache = raw.map((u: any) => ({
      txid:     u.txid,
      vout:     u.vout,
      satoshis: BigInt(u.value),
      script:   u.scriptPubKey,
      txHex:    u.rawTx,
    }));
    cacheAge = Date.now();
    return utxoCache;
  } catch (err: any) {
    console.warn("⚠️  UTXO refresh failed:", err.message);
    return utxoCache; // use stale
  }
}

function consumeUTXO(txid: string, vout: number) {
  utxoCache = utxoCache.filter(u => !(u.txid === txid && u.vout === vout));
}

// ─── Build & sign micropayment TX ─────────────────────────────────────────────

async function buildPaymentTx(
  toAddress: string,
  satoshis:  number
): Promise<{ tx: Transaction; txHex: string; changeUTXO: UTXO | null }> {
  const utxos        = await refreshUTXOs();
  const targetSats   = BigInt(satoshis);
  const FEE_RATE     = 10n;  // 10 sat/KB — BSV is very cheap
  const DUST         = 546n;

  // Select UTXOs (largest-first for simplicity; replace with Branch-and-Bound for production)
  const sorted = [...utxos].sort((a, b) => Number(b.satoshis - a.satoshis));
  let   accumulated = 0n;
  const selected: UTXO[] = [];

  for (const u of sorted) {
    selected.push(u);
    accumulated += u.satoshis;
    // Rough fee estimate: 148 bytes per input + 34 bytes per output + 10 overhead
    const estimatedFee = FEE_RATE * BigInt(148 * selected.length + 68 + 10) / 1000n + 1n;
    if (accumulated >= targetSats + estimatedFee) break;
  }

  if (selected.length === 0) throw new Error("No UTXOs available");

  const p2pkh          = new P2PKH();
  const payLockScript  = p2pkh.lock(toAddress);
  const changeLockScript = p2pkh.lock(CLIENT_ADDRESS);

  const tx = new Transaction();

  // Add inputs
  for (const u of selected) {
    tx.addInput({
      sourceTXID:          u.txid,
      sourceOutputIndex:   u.vout,
      sourceTransaction:   u.txHex ? Transaction.fromHex(u.txHex) : undefined,
      unlockingScriptTemplate: p2pkh.unlock(clientKey),
    } as TransactionInput);
  }

  // Payment output
  tx.addOutput({ lockingScript: payLockScript, satoshis: BigInt(satoshis) });

  // Change output (if worth it)
  const fee    = FEE_RATE * BigInt(tx.toBEEF().length) / 1000n + 1n;
  const change = accumulated - targetSats - fee;
  let changeUTXO: UTXO | null = null;
  if (change > DUST) {
    tx.addOutput({ lockingScript: changeLockScript, satoshis: change });
    changeUTXO = {
      txid:     "", // filled after signing
      vout:     tx.outputs.length - 1,
      satoshis: change,
      script:   changeLockScript.toHex(),
    };
  }

  await tx.sign();

  const txHex = tx.toHex();
  if (changeUTXO) changeUTXO.txid = tx.id("hex") as string;

  // Mark selected UTXOs as spent in cache
  for (const u of selected) consumeUTXO(u.txid, u.vout);

  return { tx, txHex, changeUTXO };
}

// ─── MCP negotiation ──────────────────────────────────────────────────────────

interface PriceSchedule { address: string; prices: Record<string, number> }

async function fetchPriceSchedule(mcp: McpClient): Promise<PriceSchedule> {
  const res = await mcp.readResource("price://*");
  const raw = res.contents[0]?.text ?? "{}";
  return JSON.parse(raw) as PriceSchedule;
}

// ─── Core negotiation + execution loop ───────────────────────────────────────

async function runNegotiationCycle(taskIndex: number): Promise<void> {
  const task = TASK_QUEUE[taskIndex % TASK_QUEUE.length];
  const ts   = new Date().toISOString();

  // 1. Discovery
  let mcp: McpClient;
  try {
    mcp = new McpClient({ url: SKILLS_MCP_URL });
    await mcp.connect();
  } catch (err: any) {
    emit({ type: "error", timestamp: ts, tool: task.tool, reason: `MCP connect failed: ${err.message}` });
    return;
  }

  emit({ type: "discovered", timestamp: ts, tool: task.tool });

  // 2. Negotiation: fetch price and check wallet balance
  let schedule: PriceSchedule;
  try {
    schedule = await fetchPriceSchedule(mcp);
  } catch (err: any) {
    emit({ type: "error", timestamp: ts, tool: task.tool, reason: `Price fetch failed: ${err.message}` });
    await mcp.close();
    return;
  }

  const price = schedule.prices[task.tool] ?? 9999;
  emit({ type: "negotiated", timestamp: ts, tool: task.tool, price });

  if (price > MAX_PRICE_SATS) {
    emit({ type: "rejected", timestamp: ts, tool: task.tool, reason: `Price ${price} > max ${MAX_PRICE_SATS}` });
    await mcp.close();
    return;
  }

  // Check balance
  const utxos   = await refreshUTXOs();
  const balance = utxos.reduce((acc, u) => acc + Number(u.satoshis), 0);
  if (balance < MIN_BALANCE_SATS) {
    emit({ type: "rejected", timestamp: ts, tool: task.tool, reason: `Balance ${balance} < min ${MIN_BALANCE_SATS}` });
    await mcp.close();
    return;
  }

  // 3. Build & sign payment
  let txHex: string;
  let txid: string;
  let changeUTXO: UTXO | null;

  try {
    const built = await buildPaymentTx(schedule.address, price);
    txHex      = built.txHex;
    txid       = built.tx.id("hex") as string;
    changeUTXO = built.changeUTXO;

    // Add change UTXO back to cache for future cycles
    if (changeUTXO) utxoCache.push(changeUTXO);

    emit({ type: "paid", timestamp: ts, tool: task.tool, price, txid });
  } catch (err: any) {
    emit({ type: "error", timestamp: ts, tool: task.tool, reason: `TX build failed: ${err.message}` });
    await mcp.close();
    return;
  }

  // 4. Call the tool with payment proof
  try {
    const result = await mcp.callTool(task.tool, {
      payment_tx_hex: txHex,
      ...task.payload,
    });

    const text = result.content?.[0]?.text ?? "{}";
    emit({ type: "executed", timestamp: ts, tool: task.tool, txid, result: JSON.parse(text) });
  } catch (err: any) {
    emit({ type: "error", timestamp: ts, tool: task.tool, reason: `Tool call failed: ${err.message}`, txid });
  } finally {
    await mcp.close();
  }
}

// ─── Autonomous scheduler ─────────────────────────────────────────────────────

let cycleCount   = 0;
let isRunning    = false;

/**
 * Schedule cycles to hit ~17 TPS on-chain.
 * We stagger individual agent calls; the bulk of TPS comes from tx-engine.ts
 * which fans out UTXO chains in parallel. This agent loop runs every 200 ms
 * contributing ~5 TPS of "meaningful" negotiation transactions.
 */
const CYCLE_INTERVAL_MS = 200;

export function startClientAgent(): NodeJS.Timeout {
  isRunning = true;
  console.log("🤖  ClientAgent autonomous loop started — negotiating every 200ms");

  const handle = setInterval(async () => {
    if (!isRunning) return;
    const idx = cycleCount++;
    // Run without awaiting so next interval fires independently
    runNegotiationCycle(idx).catch(err =>
      console.error("Unhandled cycle error:", err)
    );
  }, CYCLE_INTERVAL_MS);

  return handle;
}

export function stopClientAgent(handle: NodeJS.Timeout): void {
  isRunning = false;
  clearInterval(handle);
  console.log("🛑  ClientAgent stopped after", cycleCount, "cycles.");
}

// ─── Standalone entry point ───────────────────────────────────────────────────

if (require.main === module) {
  const handle = startClientAgent();

  // Graceful shutdown
  process.on("SIGINT",  () => { stopClientAgent(handle); process.exit(0); });
  process.on("SIGTERM", () => { stopClientAgent(handle); process.exit(0); });

  agentBus.on("event", (e: NegotiationEvent) => {
    if (process.env.LOG_EVENTS === "1") console.dir(e, { depth: 3 });
  });
}
