/**
 * AgenticFlow — Skills Agent MCP Server
 * Exposes autonomous capabilities with dynamic pricing via @bsv/simple-mcp.
 * Each tool advertises its BSV micropayment price; the engine enforces payment
 * before executing any skill, making every interaction an on-chain transaction.
 *
 * Architecture: Skills Agent acts as the "marketplace" side.
 *   - Registers tools with price schedules
 *   - Validates incoming payment proofs before running tasks
 *   - Streams results back through the MCP channel
 */

import { McpServer, ResourceTemplate } from "@bsv/simple-mcp";
import { SimpleSPV } from "@bsv/simple";
import { Transaction, PrivateKey, P2PKH, Script } from "@bsv/sdk";
import * as os from "os";
import * as crypto from "crypto";

// ─── Wallet bootstrap ────────────────────────────────────────────────────────

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

// SPV client for payment verification (no full node needed)
const spv = new SimpleSPV({ arcUrl: ARC_API_URL, apiKey: ARC_API_KEY });

// ─── Price schedule (satoshis) ───────────────────────────────────────────────

const PRICE_SCHEDULE: Record<string, number> = {
  sentiment_analysis:  50,   // 50 sats  ≈ $0.000025
  summarise_text:      80,
  translate_text:      60,
  classify_intent:     40,
  generate_embedding: 120,
  fetch_weather:       30,
  run_sql_query:      200,
};

// ─── Payment proof store (in-memory; replace with Redis in prod) ─────────────

interface PaymentRecord {
  txid:      string;
  satoshis:  number;
  tool:      string;
  usedAt:    number | null;
}
const paymentStore = new Map<string, PaymentRecord>();

// ─── Helper: verify a BSV micropayment ───────────────────────────────────────

async function verifyPayment(
  txHex:    string,
  toolName: string
): Promise<{ valid: boolean; txid: string; satoshis: number }> {
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(txHex);
  } catch {
    return { valid: false, txid: "", satoshis: 0 };
  }

  const txid = tx.id("hex") as string;

  // Reject if already consumed
  const existing = paymentStore.get(txid);
  if (existing?.usedAt) {
    return { valid: false, txid, satoshis: 0 };
  }

  // Find output paying to our address
  const p2pkh      = new P2PKH();
  const lockScript = p2pkh.lock(AGENT_ADDRESS);
  let   satoshis   = 0;

  for (const output of tx.outputs) {
    if (output.lockingScript.toHex() === lockScript.toHex()) {
      satoshis += Number(output.satoshis);
    }
  }

  const required = PRICE_SCHEDULE[toolName] ?? 9999;
  if (satoshis < required) {
    return { valid: false, txid, satoshis };
  }

  // Broadcast via ARC and wait for SEEN_ON_NETWORK status
  try {
    const result = await spv.broadcast(tx);
    if (result.status !== "SEEN_ON_NETWORK" && result.status !== "MINED") {
      return { valid: false, txid, satoshis };
    }
  } catch (err: any) {
    // If already in mempool that is acceptable
    if (!err.message?.includes("already known")) {
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

// ─── Skills implementation ───────────────────────────────────────────────────

async function doSentimentAnalysis(text: string): Promise<string> {
  // Real work: basic lexicon-based sentiment (production: call ML model)
  const positive = ["good","great","excellent","happy","love","best","amazing"];
  const negative = ["bad","terrible","awful","hate","worst","poor","horrible"];
  const words    = text.toLowerCase().split(/\W+/);
  const pos      = words.filter(w => positive.includes(w)).length;
  const neg      = words.filter(w => negative.includes(w)).length;
  const score    = pos - neg;
  const label    = score > 0 ? "POSITIVE" : score < 0 ? "NEGATIVE" : "NEUTRAL";
  return JSON.stringify({ label, score, pos, neg });
}

async function doSummariseText(text: string): Promise<string> {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const summary   = sentences.slice(0, Math.min(3, sentences.length)).join(" ").trim();
  return JSON.stringify({ summary, original_length: text.length, summary_length: summary.length });
}

async function doTranslate(text: string, target: string): Promise<string> {
  // Stub — wire to LibreTranslate or DeepL in production
  return JSON.stringify({
    translated: `[${target.toUpperCase()}] ${text}`,
    source: "auto",
    target,
  });
}

async function doClassifyIntent(text: string): Promise<string> {
  const intents: Record<string, RegExp> = {
    question:    /\?|what|how|why|when|where|who/i,
    command:     /please|do|run|execute|start|stop/i,
    greeting:    /hello|hi|hey|good morning|good evening/i,
    payment:     /pay|send|transfer|satoshi|bsv/i,
    information: /.*/,
  };
  for (const [intent, re] of Object.entries(intents)) {
    if (re.test(text)) return JSON.stringify({ intent, confidence: 0.87 });
  }
  return JSON.stringify({ intent: "unknown", confidence: 0 });
}

// ─── MCP Server definition ───────────────────────────────────────────────────

const server = new McpServer({
  name:        "AgenticFlow-SkillsAgent",
  version:     "1.0.0",
  description: "Autonomous BSV-paid skills marketplace. All tools require a valid micropayment proof.",
  port:        MCP_PORT,
});

// ── Resource: price schedule (public, no payment needed) ─────────────────────
server.resource(
  "price-schedule",
  new ResourceTemplate("price://{tool}", { list: undefined }),
  async (uri, { tool }) => {
    const name  = Array.isArray(tool) ? tool[0] : tool;
    const price = name === "*"
      ? PRICE_SCHEDULE
      : { [name]: PRICE_SCHEDULE[name] ?? null };
    return {
      contents: [{
        uri:      uri.href,
        mimeType: "application/json",
        text:     JSON.stringify({ address: AGENT_ADDRESS, prices: price }),
      }],
    };
  }
);

// ── Resource: agent status ────────────────────────────────────────────────────
server.resource("agent-status", "status://current", async () => ({
  contents: [{
    uri:      "status://current",
    mimeType: "application/json",
    text: JSON.stringify({
      agent:     "SkillsAgent",
      address:   AGENT_ADDRESS,
      uptime:    process.uptime(),
      hostname:  os.hostname(),
      payments:  paymentStore.size,
      timestamp: new Date().toISOString(),
    }),
  }],
}));

// ── Tool: sentiment_analysis ─────────────────────────────────────────────────
server.tool(
  "sentiment_analysis",
  {
    description: `Analyse sentiment of text. Price: ${PRICE_SCHEDULE.sentiment_analysis} satoshis.`,
    inputSchema: {
      type: "object",
      properties: {
        payment_tx_hex: { type: "string", description: "Signed BSV transaction hex paying the agent address." },
        text:           { type: "string", description: "Text to analyse." },
      },
      required: ["payment_tx_hex", "text"],
    },
  },
  async ({ payment_tx_hex, text }) => {
    const { valid, txid, satoshis } = await verifyPayment(payment_tx_hex, "sentiment_analysis");
    if (!valid) {
      return { content: [{ type: "text", text: `❌ Payment invalid or insufficient. Required: ${PRICE_SCHEDULE.sentiment_analysis} sats.` }], isError: true };
    }
    consumePayment(txid);
    const result = await doSentimentAnalysis(text);
    return { content: [{ type: "text", text: JSON.stringify({ txid, satoshis_paid: satoshis, result: JSON.parse(result) }) }] };
  }
);

// ── Tool: summarise_text ──────────────────────────────────────────────────────
server.tool(
  "summarise_text",
  {
    description: `Summarise long text. Price: ${PRICE_SCHEDULE.summarise_text} satoshis.`,
    inputSchema: {
      type: "object",
      properties: {
        payment_tx_hex: { type: "string" },
        text:           { type: "string" },
      },
      required: ["payment_tx_hex", "text"],
    },
  },
  async ({ payment_tx_hex, text }) => {
    const { valid, txid, satoshis } = await verifyPayment(payment_tx_hex, "summarise_text");
    if (!valid) return { content: [{ type: "text", text: "❌ Payment rejected." }], isError: true };
    consumePayment(txid);
    const result = await doSummariseText(text);
    return { content: [{ type: "text", text: JSON.stringify({ txid, satoshis_paid: satoshis, result: JSON.parse(result) }) }] };
  }
);

// ── Tool: classify_intent ─────────────────────────────────────────────────────
server.tool(
  "classify_intent",
  {
    description: `Classify intent of a message. Price: ${PRICE_SCHEDULE.classify_intent} satoshis.`,
    inputSchema: {
      type: "object",
      properties: {
        payment_tx_hex: { type: "string" },
        text:           { type: "string" },
      },
      required: ["payment_tx_hex", "text"],
    },
  },
  async ({ payment_tx_hex, text }) => {
    const { valid, txid, satoshis } = await verifyPayment(payment_tx_hex, "classify_intent");
    if (!valid) return { content: [{ type: "text", text: "❌ Payment rejected." }], isError: true };
    consumePayment(txid);
    const result = await doClassifyIntent(text);
    return { content: [{ type: "text", text: JSON.stringify({ txid, satoshis_paid: satoshis, result: JSON.parse(result) }) }] };
  }
);

// ── Tool: translate_text ──────────────────────────────────────────────────────
server.tool(
  "translate_text",
  {
    description: `Translate text to a target language. Price: ${PRICE_SCHEDULE.translate_text} satoshis.`,
    inputSchema: {
      type: "object",
      properties: {
        payment_tx_hex: { type: "string" },
        text:           { type: "string" },
        target_lang:    { type: "string", description: "ISO 639-1 code, e.g. 'es', 'fr', 'zh'" },
      },
      required: ["payment_tx_hex", "text", "target_lang"],
    },
  },
  async ({ payment_tx_hex, text, target_lang }) => {
    const { valid, txid, satoshis } = await verifyPayment(payment_tx_hex, "translate_text");
    if (!valid) return { content: [{ type: "text", text: "❌ Payment rejected." }], isError: true };
    consumePayment(txid);
    const result = await doTranslate(text, target_lang);
    return { content: [{ type: "text", text: JSON.stringify({ txid, satoshis_paid: satoshis, result: JSON.parse(result) }) }] };
  }
);

// ─── Start server ─────────────────────────────────────────────────────────────

server.start().then(() => {
  console.log(`🟢  SkillsAgent MCP server running on port ${MCP_PORT}`);
  console.log(`💳  Receiving payments at: ${AGENT_ADDRESS}`);
  console.log(`📋  Available tools: ${Object.keys(PRICE_SCHEDULE).join(", ")}`);
}).catch((err: Error) => {
  console.error("💥  Failed to start MCP server:", err.message);
  process.exit(1);
});

export { server };
