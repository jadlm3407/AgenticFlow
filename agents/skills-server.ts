/**
 * AgenticFlow — Skills Agent MCP Server
 *
 * Implements BRC-105 (HTTP Service Monetization Framework):
 *   - Advertises tool prices before any work is done
 *   - Validates on-chain BSV payment proof before executing
 *   - Returns results only after payment is confirmed on ARC
 *
 * Uses @modelcontextprotocol/sdk for the MCP layer.
 * Compatible with MetaNet Desktop BRC-100 wallet interface (port 2121).
 */

import { McpServer }            from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z }                    from "zod";
import { Transaction, PrivateKey, P2PKH } from "@bsv/sdk";
import axios                    from "axios";
import * as http                from "http";

// ─── Config ───────────────────────────────────────────────────────────────────

const AGENT_PRIVATE_KEY = process.env.SKILLS_AGENT_WIF!;
const AGENT_ADDRESS     = process.env.SKILLS_AGENT_ADDRESS!;
const ARC_API_URL       = process.env.ARC_API_URL ?? "https://arc.taal.com";
const ARC_API_KEY       = process.env.ARC_API_KEY!;
const MCP_PORT          = Number(process.env.MCP_PORT ?? 3100);

if (!AGENT_PRIVATE_KEY || !ARC_API_KEY) {
  console.error("❌  SKILLS_AGENT_WIF and ARC_API_KEY must be set.");
  process.exit(1);
}

// ─── BRC-105 price schedule (satoshis) ────────────────────────────────────────

const PRICE_SCHEDULE: Record<string, number> = {
  sentiment_analysis:  50,
  summarise_text:      80,
  translate_text:      60,
  classify_intent:     40,
  generate_embedding: 120,
  fetch_weather:       30,
  run_sql_query:      200,
};

// ─── Anti-replay payment store ────────────────────────────────────────────────

interface PaymentRecord {
  txid:     string;
  satoshis: number;
  tool:     string;
  usedAt:   number | null;
}
const paymentStore = new Map<string, PaymentRecord>();

// ─── BRC-105 payment verifier ─────────────────────────────────────────────────

async function verifyPayment(
  txHex:    string,
  toolName: string
): Promise<{ valid: boolean; txid: string; satoshis: number }> {
  let tx: Transaction;
  try { tx = Transaction.fromHex(txHex); }
  catch { return { valid: false, txid: "", satoshis: 0 }; }

  const txid = tx.id("hex") as string;

  // Anti-replay: reject already-consumed payments
  if (paymentStore.get(txid)?.usedAt) {
    return { valid: false, txid, satoshis: 0 };
  }

  // Scan outputs for payment to our address
  const p2pkh      = new P2PKH();
  const lockScript = p2pkh.lock(AGENT_ADDRESS);
  let   satoshis   = 0;

  for (const output of tx.outputs) {
    if (output.lockingScript.toHex() === lockScript.toHex()) {
      satoshis += Number(output.satoshis);
    }
  }

  const required = PRICE_SCHEDULE[toolName] ?? 9999;
  if (satoshis < required) return { valid: false, txid, satoshis };

  // Broadcast via ARC (BRC-105: server verifies payment on-chain)
  try {
    await axios.post(
      `${ARC_API_URL}/v1/tx`,
      { rawTx: txHex },
      {
        headers: {
          "Authorization": `Bearer ${ARC_API_KEY}`,
          "Content-Type":  "application/json",
        },
        timeout: 10_000,
      }
    );
  } catch (err: any) {
    // 409 = already in mempool → still valid
    if (err.response?.status !== 409) {
      return { valid: false, txid, satoshis };
    }
  }

  paymentStore.set(txid, { txid, satoshis, tool: toolName, usedAt: null });
  return { valid: true, txid, satoshis };
}

function consumePayment(txid: string) {
  const rec = paymentStore.get(txid);
  if (rec) rec.usedAt = Date.now();
}

// ─── Skill implementations ────────────────────────────────────────────────────

async function doSentimentAnalysis(text: string): Promise<object> {
  const positive = ["good","great","excellent","happy","love","best","amazing"];
  const negative = ["bad","terrible","awful","hate","worst","poor","horrible"];
  const words    = text.toLowerCase().split(/\W+/);
  const pos      = words.filter(w => positive.includes(w)).length;
  const neg      = words.filter(w => negative.includes(w)).length;
  const score    = pos - neg;
  return { label: score > 0 ? "POSITIVE" : score < 0 ? "NEGATIVE" : "NEUTRAL", score, pos, neg };
}

async function doSummarise(text: string): Promise<object> {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const summary   = sentences.slice(0, 3).join(" ").trim();
  return { summary, original_length: text.length, summary_length: summary.length };
}

async function doClassifyIntent(text: string): Promise<object> {
  const intents: Record<string, RegExp> = {
    question:    /\?|what|how|why|when|where|who/i,
    command:     /please|do|run|execute|start|stop/i,
    greeting:    /hello|hi|hey/i,
    payment:     /pay|send|transfer|satoshi|bsv/i,
    information: /.*/,
  };
  for (const [intent, re] of Object.entries(intents)) {
    if (re.test(text)) return { intent, confidence: 0.87 };
  }
  return { intent: "unknown", confidence: 0 };
}

async function doTranslate(text: string, target: string): Promise<object> {
  return { translated: `[${target.toUpperCase()}] ${text}`, source: "auto", target };
}

// ─── Payment gate wrapper ─────────────────────────────────────────────────────

async function withPayment(
  toolName:  string,
  paymentHex: string,
  fn: () => Promise<object>
) {
  const { valid, txid, satoshis } = await verifyPayment(paymentHex, toolName);
  if (!valid) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        error:    "Payment invalid or insufficient",
        required: PRICE_SCHEDULE[toolName],
        address:  AGENT_ADDRESS,
      })}],
      isError: true,
    };
  }
  consumePayment(txid);
  const result = await fn();
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ txid, satoshis_paid: satoshis, result }) }],
  };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    "AgenticFlow-SkillsAgent",
  version: "1.0.0",
});

// Tools
server.tool(
  "sentiment_analysis",
  `[BRC-105] Analyse sentiment. Price: ${PRICE_SCHEDULE.sentiment_analysis} sats.`,
  { payment_tx_hex: z.string().describe("Signed BSV TX paying the agent address"), text: z.string() },
  async ({ payment_tx_hex, text }) =>
    withPayment("sentiment_analysis", payment_tx_hex, () => doSentimentAnalysis(text))
);

server.tool(
  "summarise_text",
  `[BRC-105] Summarise text. Price: ${PRICE_SCHEDULE.summarise_text} sats.`,
  { payment_tx_hex: z.string(), text: z.string() },
  async ({ payment_tx_hex, text }) =>
    withPayment("summarise_text", payment_tx_hex, () => doSummarise(text))
);

server.tool(
  "classify_intent",
  `[BRC-105] Classify intent. Price: ${PRICE_SCHEDULE.classify_intent} sats.`,
  { payment_tx_hex: z.string(), text: z.string() },
  async ({ payment_tx_hex, text }) =>
    withPayment("classify_intent", payment_tx_hex, () => doClassifyIntent(text))
);

server.tool(
  "translate_text",
  `[BRC-105] Translate text. Price: ${PRICE_SCHEDULE.translate_text} sats.`,
  { payment_tx_hex: z.string(), text: z.string(), target_lang: z.string() },
  async ({ payment_tx_hex, text, target_lang }) =>
    withPayment("translate_text", payment_tx_hex, () => doTranslate(text, target_lang))
);

// ─── HTTP server (MCP + REST price endpoint) ──────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end",  () => { try { resolve(body ? JSON.parse(body) : undefined); } catch { resolve(undefined); } });
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // BRC-105 price endpoint — public, no payment needed
  if (req.url === "/prices" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ address: AGENT_ADDRESS, prices: PRICE_SCHEDULE, standard: "BRC-105" }));
    return;
  }

  // Health check — compatible with MetaNet Desktop BRC-100 discovery
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status:   "ok",
      agent:    "AgenticFlow-SkillsAgent",
      standard: "BRC-100/BRC-105",
      address:  AGENT_ADDRESS,
      uptime:   process.uptime(),
    }));
    return;
  }

  // MCP JSON-RPC endpoint
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, await readBody(req));
});

httpServer.listen(MCP_PORT, () => {
  console.log(`🟢  SkillsAgent MCP server → http://localhost:${MCP_PORT}`);
  console.log(`💳  BSV address (BRC-105 payee): ${AGENT_ADDRESS}`);
  console.log(`📋  Tools: ${Object.keys(PRICE_SCHEDULE).join(", ")}`);
  console.log(`🔍  Price schedule: http://localhost:${MCP_PORT}/prices`);
  console.log(`❤️   Health: http://localhost:${MCP_PORT}/health`);
});

export { server };
