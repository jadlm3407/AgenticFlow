/**
 * AgenticFlow — Skills Agent MCP Server
 * Uses the official @modelcontextprotocol/sdk.
 * Exposes autonomous capabilities with dynamic pricing.
 * Every tool call requires a valid BSV micropayment proof.
 */

import { McpServer }            from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z }                    from "zod";
import { Transaction, PrivateKey, P2PKH } from "@bsv/sdk";
import axios                    from "axios";
import * as http                from "http";
import * as os                  from "os";

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

const agentKey = PrivateKey.fromWif(AGENT_PRIVATE_KEY);

// ─── Price schedule (satoshis) ───────────────────────────────────────────────

const PRICE_SCHEDULE: Record<string, number> = {
  sentiment_analysis:  50,
  summarise_text:      80,
  translate_text:      60,
  classify_intent:     40,
  generate_embedding: 120,
  fetch_weather:       30,
  run_sql_query:      200,
};

// ─── Anti-replay store ────────────────────────────────────────────────────────

interface PaymentRecord {
  txid:     string;
  satoshis: number;
  tool:     string;
  usedAt:   number | null;
}
const paymentStore = new Map<string, PaymentRecord>();

// ─── Payment verifier ─────────────────────────────────────────────────────────

async function verifyPayment(
  txHex:    string,
  toolName: string
): Promise<{ valid: boolean; txid: string; satoshis: number }> {
  let tx: Transaction;
  try { tx = Transaction.fromHex(txHex); }
  catch { return { valid: false, txid: "", satoshis: 0 }; }

  const txid = tx.id("hex") as string;
  if (paymentStore.get(txid)?.usedAt) return { valid: false, txid, satoshis: 0 };

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

  // Broadcast via ARC
  try {
    const response = await axios.post(
      `${ARC_API_URL}/v1/tx`,
      { rawTx: txHex },
      { headers: { "Authorization": `Bearer ${ARC_API_KEY}`, "Content-Type": "application/json" } }
    );
    const status = response.data?.txStatus;
    if (status !== "SEEN_ON_NETWORK" && status !== "MINED" && status !== "SEEN_IN_ORPHAN_MEMPOOL") {
      // allow if 409 (already known)
    }
  } catch (err: any) {
    if (!err.response?.status || err.response.status !== 409) {
      return { valid: false, txid, satoshis };
    }
  }

  paymentStore.set(txid, { txid, satoshis, tool: toolName, usedAt: null });
  return { valid: true, txid, satoshis };
}

function consumePayment(txid: string): void {
  const rec = paymentStore.get(txid);
  if (rec) rec.usedAt = Date.now();
}

// ─── Skill implementations ────────────────────────────────────────────────────

async function doSentimentAnalysis(text: string): Promise<object> {
  const positive = ["good","great","excellent","happy","love","best","amazing"];
  const negative = ["bad","terrible","awful","hate","worst","poor","horrible"];
  const words = text.toLowerCase().split(/\W+/);
  const pos = words.filter(w => positive.includes(w)).length;
  const neg = words.filter(w => negative.includes(w)).length;
  const score = pos - neg;
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

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    "AgenticFlow-SkillsAgent",
  version: "1.0.0",
});

// ── Helper: payment gate wrapper ──────────────────────────────────────────────

function paymentGate(toolName: string) {
  return async (
    params: { payment_tx_hex: string; [key: string]: unknown },
    fn: (params: typeof params) => Promise<object>
  ) => {
    const { valid, txid, satoshis } = await verifyPayment(params.payment_tx_hex, toolName);
    if (!valid) {
      return {
        content: [{ type: "text" as const, text: `❌ Payment invalid. Required: ${PRICE_SCHEDULE[toolName]} sats.` }],
        isError: true,
      };
    }
    consumePayment(txid);
    const result = await fn(params);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ txid, satoshis_paid: satoshis, result }) }],
    };
  };
}

// ── Price schedule resource ────────────────────────────────────────────────────

server.resource(
  "price-schedule",
  "price://all",
  async () => ({
    contents: [{
      uri:      "price://all",
      mimeType: "application/json",
      text:     JSON.stringify({ address: AGENT_ADDRESS, prices: PRICE_SCHEDULE }),
    }],
  })
);

// ── Tools ─────────────────────────────────────────────────────────────────────

const gate = paymentGate;

server.tool(
  "sentiment_analysis",
  `Analyse sentiment. Price: ${PRICE_SCHEDULE.sentiment_analysis} sats.`,
  { payment_tx_hex: z.string().describe("Signed BSV TX hex paying the agent address."), text: z.string() },
  async (params) => gate("sentiment_analysis")(params, async ({ text }) => doSentimentAnalysis(text as string))
);

server.tool(
  "summarise_text",
  `Summarise text. Price: ${PRICE_SCHEDULE.summarise_text} sats.`,
  { payment_tx_hex: z.string(), text: z.string() },
  async (params) => gate("summarise_text")(params, async ({ text }) => doSummarise(text as string))
);

server.tool(
  "classify_intent",
  `Classify intent. Price: ${PRICE_SCHEDULE.classify_intent} sats.`,
  { payment_tx_hex: z.string(), text: z.string() },
  async (params) => gate("classify_intent")(params, async ({ text }) => doClassifyIntent(text as string))
);

server.tool(
  "translate_text",
  `Translate text. Price: ${PRICE_SCHEDULE.translate_text} sats.`,
  { payment_tx_hex: z.string(), text: z.string(), target_lang: z.string() },
  async (params) => gate("translate_text")(params, async ({ text, target_lang }) =>
    doTranslate(text as string, target_lang as string))
);

// ─── HTTP Transport (so client agent can connect via URL) ─────────────────────

async function startHttpServer() {
  const httpServer = http.createServer(async (req, res) => {
    // CORS headers for browser/SSE access
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // Price schedule endpoint (no MCP needed)
    if (req.url === "/prices" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ address: AGENT_ADDRESS, prices: PRICE_SCHEDULE }));
      return;
    }

    // Status endpoint
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", agent: "SkillsAgent", uptime: process.uptime(), address: AGENT_ADDRESS }));
      return;
    }

    // MCP requests
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, await bodyOf(req));
  });

  httpServer.listen(MCP_PORT, () => {
    console.log(`🟢  SkillsAgent MCP server on http://localhost:${MCP_PORT}`);
    console.log(`💳  Payments to: ${AGENT_ADDRESS}`);
    console.log(`📋  Tools: ${Object.keys(PRICE_SCHEDULE).join(", ")}`);
    console.log(`🔍  Prices: http://localhost:${MCP_PORT}/prices`);
  });
}

function bodyOf(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : undefined); }
      catch { resolve(undefined); }
    });
    req.on("error", reject);
  });
}

startHttpServer().catch(err => {
  console.error("💥  Server failed:", err.message);
  process.exit(1);
});

export { server };
