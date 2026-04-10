/**
 * AgenticFlow — Client Agent (Autonomous Buyer)
 * Uses @modelcontextprotocol/sdk Client + @bsv/sdk for payments.
 * Runs a self-scheduling loop with NO human triggers.
 */

import { Client }             from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transaction, PrivateKey, P2PKH, ARC } from "@bsv/sdk";
import axios                  from "axios";
import EventEmitter           from "events";

// ─── Config ───────────────────────────────────────────────────────────────────

const CLIENT_WIF       = process.env.CLIENT_AGENT_WIF!;
const CLIENT_ADDRESS   = process.env.CLIENT_AGENT_ADDRESS!;
const ARC_API_URL      = process.env.ARC_API_URL ?? "https://arc.taal.com";
const ARC_API_KEY      = process.env.ARC_API_KEY!;
const SKILLS_MCP_URL   = process.env.SKILLS_MCP_URL ?? "http://localhost:3100";
const MAX_PRICE_SATS   = Number(process.env.MAX_PRICE_SATS ?? 500);
const MIN_BALANCE_SATS = Number(process.env.MIN_BALANCE_SATS ?? 5_000);

if (!CLIENT_WIF || !ARC_API_KEY) {
  console.error("❌  CLIENT_AGENT_WIF and ARC_API_KEY must be set.");
  process.exit(1);
}

const clientKey = PrivateKey.fromWif(CLIENT_WIF);
const arc       = new ARC(ARC_API_URL, { apiKey: ARC_API_KEY });

// ─── Task queue (cycles autonomously) ────────────────────────────────────────

const TASK_QUEUE = [
  { tool: "sentiment_analysis", payload: { text: "BSV is the best blockchain for enterprise data." } },
  { tool: "classify_intent",    payload: { text: "Please send 100 satoshis to Alice." } },
  { tool: "summarise_text",     payload: { text: "Bitcoin SV (BSV) is a cryptocurrency created as a hard fork of Bitcoin Cash in November 2018. BSV aims to fulfil the original vision of Bitcoin as described by Satoshi Nakamoto, focusing on scalability, stability, and security. It supports large block sizes to enable more transactions per second on-chain." } },
  { tool: "translate_text",     payload: { text: "Hello, world!", target_lang: "es" } },
];

// ─── Event bus ────────────────────────────────────────────────────────────────

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
  const icons = { discovered:"🔍", negotiated:"🤝", paid:"💸", executed:"✅", rejected:"❌", error:"💥" };
  console.log(`${icons[event.type]}  [${event.timestamp}] ${event.type.toUpperCase()} — ${event.tool}`, event.txid ?? event.reason ?? "");
}

// ─── UTXO cache ───────────────────────────────────────────────────────────────

interface UTXO {
  txid:     string;
  vout:     number;
  satoshis: bigint;
  script:   string;
  rawTx?:   string;
}

let utxoCache: UTXO[] = [];
let cacheAge          = 0;
const CACHE_TTL_MS    = 15_000;

async function refreshUTXOs(): Promise<UTXO[]> {
  if (Date.now() - cacheAge < CACHE_TTL_MS && utxoCache.length > 0) return utxoCache;
  try {
    // Query WhatsOnChain API (free, no auth needed)
    const res = await axios.get(
      `https://api.whatsonchain.com/v1/bsv/main/address/${CLIENT_ADDRESS}/unspent`,
      { timeout: 10_000 }
    );
    const rawTxCache = new Map<string, string>();
    utxoCache = await Promise.all(
      res.data.map(async (u: any) => {
        let rawTx = rawTxCache.get(u.tx_hash);
        if (!rawTx) {
          try {
            const txRes = await axios.get(`https://api.whatsonchain.com/v1/bsv/main/tx/${u.tx_hash}/hex`, { timeout: 8_000 });
            rawTx = txRes.data as string;
            rawTxCache.set(u.tx_hash, rawTx);
          } catch { rawTx = undefined; }
        }
        return {
          txid:     u.tx_hash as string,
          vout:     u.tx_pos  as number,
          satoshis: BigInt(u.value),
          script:   new P2PKH().lock(CLIENT_ADDRESS).toHex(),
          rawTx,
        };
      })
    );
    cacheAge = Date.now();
    return utxoCache;
  } catch (err: any) {
    console.warn("⚠️  UTXO refresh failed:", err.message);
    return utxoCache;
  }
}

function consumeUTXO(txid: string, vout: number) {
  utxoCache = utxoCache.filter(u => !(u.txid === txid && u.vout === vout));
}

// ─── Build & sign micropayment TX ─────────────────────────────────────────────

async function buildPaymentTx(
  toAddress: string,
  satoshis:  number
): Promise<{ tx: Transaction; txHex: string }> {
  const utxos      = await refreshUTXOs();
  const targetSats = BigInt(satoshis);
  const DUST       = 546n;
  const FEE        = 200n;

  const sorted   = [...utxos].sort((a, b) => Number(b.satoshis - a.satoshis));
  let accumulated = 0n;
  const selected: UTXO[] = [];

  for (const u of sorted) {
    selected.push(u);
    accumulated += u.satoshis;
    if (accumulated >= targetSats + FEE) break;
  }

  if (selected.length === 0) throw new Error("No UTXOs available — fund CLIENT_AGENT_ADDRESS first");

  const p2pkh     = new P2PKH();
  const tx        = new Transaction();

  for (const u of selected) {
    tx.addInput({
      sourceTXID:              u.txid,
      sourceOutputIndex:       u.vout,
      sourceTransaction:       u.rawTx ? Transaction.fromHex(u.rawTx) : undefined,
      unlockingScriptTemplate: p2pkh.unlock(clientKey),
    } as any);
  }

  tx.addOutput({ lockingScript: p2pkh.lock(toAddress),       satoshis: BigInt(satoshis) });

  const change = accumulated - targetSats - FEE;
  if (change > DUST) {
    tx.addOutput({ lockingScript: p2pkh.lock(CLIENT_ADDRESS), satoshis: change });
    // Add change back to local cache
    utxoCache.push({
      txid: "", vout: tx.outputs.length - 1,
      satoshis: change, script: p2pkh.lock(CLIENT_ADDRESS).toHex(),
    });
  }

  await tx.sign();
  const txHex = tx.toHex();

  // Fix change txid now that we have it
  const txid = tx.id("hex") as string;
  const pending = utxoCache.find(u => u.txid === "");
  if (pending) pending.txid = txid;

  for (const u of selected) consumeUTXO(u.txid, u.vout);

  return { tx, txHex };
}

// ─── Fetch price schedule (plain HTTP — no MCP needed for this) ───────────────

interface PriceSchedule { address: string; prices: Record<string, number> }

async function fetchPriceSchedule(): Promise<PriceSchedule> {
  const res = await axios.get<PriceSchedule>(`${SKILLS_MCP_URL}/prices`, { timeout: 5_000 });
  return res.data;
}

// ─── Core negotiation cycle ───────────────────────────────────────────────────

async function runNegotiationCycle(taskIndex: number): Promise<void> {
  const task = TASK_QUEUE[taskIndex % TASK_QUEUE.length];
  const ts   = new Date().toISOString();

  // 1. Discover
  emit({ type: "discovered", timestamp: ts, tool: task.tool });

  // 2. Negotiate
  let schedule: PriceSchedule;
  try {
    schedule = await fetchPriceSchedule();
  } catch (err: any) {
    emit({ type: "error", timestamp: ts, tool: task.tool, reason: `Price fetch failed: ${err.message}` });
    return;
  }

  const price = schedule.prices[task.tool] ?? 9999;
  emit({ type: "negotiated", timestamp: ts, tool: task.tool, price });

  if (price > MAX_PRICE_SATS) {
    emit({ type: "rejected", timestamp: ts, tool: task.tool, reason: `Price ${price} > max ${MAX_PRICE_SATS}` });
    return;
  }

  // 3. Check balance
  const utxos   = await refreshUTXOs();
  const balance = utxos.reduce((acc, u) => acc + Number(u.satoshis), 0);
  if (balance < MIN_BALANCE_SATS) {
    emit({ type: "rejected", timestamp: ts, tool: task.tool, reason: `Balance ${balance} < min ${MIN_BALANCE_SATS}` });
    return;
  }

  // 4. Build & pay
  let txHex: string;
  let txid: string;
  try {
    const built = await buildPaymentTx(schedule.address, price);
    txHex = built.txHex;
    txid  = built.tx.id("hex") as string;
    emit({ type: "paid", timestamp: ts, tool: task.tool, price, txid });
  } catch (err: any) {
    emit({ type: "error", timestamp: ts, tool: task.tool, reason: `TX build failed: ${err.message}` });
    return;
  }

  // 5. Call tool via MCP
  try {
    const transport = new StreamableHTTPClientTransport(new URL(SKILLS_MCP_URL));
    const mcp       = new Client({ name: "ClientAgent", version: "1.0.0" });
    await mcp.connect(transport);

    const result = await mcp.callTool({ name: task.tool, arguments: { payment_tx_hex: txHex, ...task.payload } });
    await mcp.close();

    const text = (result.content as any)?.[0]?.text ?? "{}";
    emit({ type: "executed", timestamp: ts, tool: task.tool, txid, result: JSON.parse(text) });
  } catch (err: any) {
    emit({ type: "error", timestamp: ts, tool: task.tool, reason: `Tool call failed: ${err.message}`, txid });
  }
}

// ─── Autonomous scheduler ─────────────────────────────────────────────────────

let cycleCount = 0;
let isRunning  = false;

export function startClientAgent(): NodeJS.Timeout {
  isRunning = true;
  console.log("🤖  ClientAgent autonomous loop started — negotiating every 200ms");

  const handle = setInterval(async () => {
    if (!isRunning) return;
    const idx = cycleCount++;
    runNegotiationCycle(idx).catch(err =>
      console.error("Unhandled cycle error:", err.message)
    );
  }, 200);

  return handle;
}

export function stopClientAgent(handle: NodeJS.Timeout): void {
  isRunning = false;
  clearInterval(handle);
  console.log(`🛑  ClientAgent stopped after ${cycleCount} cycles.`);
}

// ─── Standalone entry ─────────────────────────────────────────────────────────

if (require.main === module) {
  const handle = startClientAgent();
  process.on("SIGINT",  () => { stopClientAgent(handle); process.exit(0); });
  process.on("SIGTERM", () => { stopClientAgent(handle); process.exit(0); });
}
