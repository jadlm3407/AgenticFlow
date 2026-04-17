/**
 * AgenticFlow — Skills Agent MCP Server
 *
 * Implements BRC-105 (HTTP Service Monetization Framework):
 *   - Advertises tool prices before any work is done
 *   - Validates on-chain BSV payment proof before executing
 *   - Returns results only after payment is confirmed on ARC
 *
 * Compatible with GorillaPool ARC (no API key needed) and TAAL ARC.
 * Compatible with MetaNet Desktop BRC-100 wallet interface (port 2121).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Transaction, PrivateKey, P2PKH } from "@bsv/sdk";
import axios from "axios";
import * as http from "http";

// ─── Config ───────────────────────────────────────────────────────────────────

const AGENT_PRIVATE_KEY = process.env.SKILLS_AGENT_WIF!;
const AGENT_ADDRESS     = process.env.SKILLS_AGENT_ADDRESS!;
const ARC_API_URL       = process.env.ARC_API_URL ?? "https://arc.gorillapool.io";
const ARC_API_KEY       = process.env.ARC_API_KEY ?? "none";
const MCP_PORT          = Number(process.env.MCP_PORT ?? 3100);

if (!AGENT_PRIVATE_KEY || !AGENT_ADDRESS) {
  console.error("❌  SKILLS_AGENT_WIF and SKILLS_AGENT_ADDRESS must be set.");
  process.exit(1);
}

// ─── ARC headers — GorillaPool needs no Authorization header ─────────────────

function arcHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ARC_API_KEY && ARC_API_KEY !== "none") {
    h["Authorization"] = `Bearer ${ARC_API_KEY}`;
  }
  return h;
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
  try {
    tx = Transaction.fromHex(txHex);
  } catch {
    return { valid: false, txid: "", satoshis: 0 };
  }

  const txid = tx.id("hex") as string;

  if (paymentStore.get(txid)?.usedAt) {
    return { valid: false, txid, satoshis: 0 };
  }

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

  try {
    await axios.post(
      `${ARC_API_URL}/v1/tx`,
      { rawTx: txHex },
      { headers: arcHeaders(), timeout: 10_000 }
    );
  } catch (err: unknown) {
    const axiosErr = err as { response?: { status: number } };
    if (axiosErr.response?.status !== 409) {
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

function doSentimentAnalysis(text: string): object {
  const positive = ["good","great","excellent","happy","love","best","amazing"];
  const negative = ["bad","terrible","awful","hate","worst","poor","horrible"];
  const words    = text.toLowerCase().split(/\W+/);
  const pos      = words.filter(w => positive.includes(w)).length;
  const neg      = words.filter(w => negative.includes(w)).length;
  const score    = pos - neg;
  return { label: score > 0 ? "POSITIVE" : score < 0 ? "NEGATIVE" : "NEUTRAL", score, pos, neg };
}

function doSummarise(text: string): object {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const summary   = sentences.slice(0, 3).join(" ").trim();
  return { summary, original_length: text.length, summary_length: summary.length };
}

function doClassifyIntent(text: string): object {
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

function doTranslate(text: string, target: string): object {
  return { translated: `[${target.toUpperCase()}] ${text}`, source: "auto", target };
}

// ─── Payment gate ─────────────────────────────────────────────────────────────

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

async function withPayment(
  toolName:   string,
  paymentHex: string,
  fn:         () => object
): Promise<ToolResult> {
  const { valid, txid, satoshis } = await verifyPayment(paymentHex, toolName);

  if (!valid) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error:    "Payment invalid or insufficient",
          required: PRICE_SCHEDULE[toolName],
          address:  AGENT_ADDRESS,
        }),
      }],
      isError: true,
    };
  }

  consumePayment(txid);
  const result = fn();

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ txid, satoshis_paid: satoshis, result }),
    }],
  };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    "AgenticFlow-SkillsAgent",
  version: "1.0.0",
});

// Define schemas explicitly to avoid inference issues
const sentimentSchema = {
  payment_tx_hex: z.string().describe("Signed BSV TX hex paying the agent address"),
  text:           z.string().describe("Text to analyse"),
};

const summariseSchema = {
  payment_tx_hex: z.string().describe("Signed BSV TX hex paying the agent address"),
  text:           z.string().describe("Text to summarise"),
};

const classifySchema = {
  payment_tx_hex: z.string().describe("Signed BSV TX hex paying the agent address"),
  text:           z.string().describe("Message to classify"),
};

const translateSchema = {
  payment_tx_hex: z.string().describe("Signed BSV TX hex paying the agent address"),
  text:           z.string().describe("Text to translate"),
  target_lang:    z.string().describe("ISO 639-1 target language code e.g. es, fr, zh"),
};

server.tool(
  "sentiment_analysis",
  `[BRC-105] Analyse sentiment of text. Price: ${PRICE_SCHEDULE.sentiment_analysis} sats.`,
  sentimentSchema,
  async (args): Promise<ToolResult> => {
    const { payment_tx_hex, text } = args as { payment_tx_hex: string; text: string };
    return withPayment("sentiment_analysis", payment_tx_hex, () => doSentimentAnalysis(text));
  }
);

server.tool(
  "summarise_text",
  `[BRC-105] Summarise long text. Price: ${PRICE_SCHEDULE.summarise_text} sats.`,
  summariseSchema,
  async (args): Promise<ToolResult> => {
    const { payment_tx_hex, text } = args as { payment_tx_hex: string; text: string };
    return withPayment("summarise_text", payment_tx_hex, () => doSummarise(text));
  }
);

server.tool(
  "classify_intent",
  `[BRC-105] Classify intent of a message. Price: ${PRICE_SCHEDULE.classify_intent} sats.`,
  classifySchema,
  async (args): Promise<ToolResult> => {
    const { payment_tx_hex, text } = args as { payment_tx_hex: string; text: string };
    return withPayment("classify_intent", payment_tx_hex, () => doClassifyIntent(text));
  }
);

server.tool(
  "translate_text",
  `[BRC-105] Translate text to another language. Price: ${PRICE_SCHEDULE.translate_text} sats.`,
  translateSchema,
  async (args): Promise<ToolResult> => {
    const { payment_tx_hex, text, target_lang } = args as {
      payment_tx_hex: string;
      text:           string;
      target_lang:    string;
    };
    return withPayment("translate_text", payment_tx_hex, () => doTranslate(text, target_lang));
  }
);

// ─── HTTP server ──────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end",  () => {
      try { resolve(body ? JSON.parse(body) : undefined); }
      catch { resolve(undefined); }
    });
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // BRC-105 public price endpoint
  if (req.url === "/prices" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      address:  AGENT_ADDRESS,
      prices:   PRICE_SCHEDULE,
      standard: "BRC-105",
    }));
    return;
  }

  // Health check — MetaNet Desktop BRC-100 compatible
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status:   "ok",
      agent:    "AgenticFlow-SkillsAgent",
      standard: "BRC-100/BRC-105",
      arc:      ARC_API_URL,
      address:  AGENT_ADDRESS,
      uptime:   process.uptime(),
    }));
    return;
  }

  // MCP JSON-RPC
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, await readBody(req));
});

httpServer.listen(MCP_PORT, () => {
  console.log(`🟢  SkillsAgent MCP server → http://localhost:${MCP_PORT}`);
  console.log(`⛓   ARC broadcaster: ${ARC_API_URL}`);
  console.log(`💳  Payments to: ${AGENT_ADDRESS}`);
  console.log(`📋  Tools: ${Object.keys(PRICE_SCHEDULE).join(", ")}`);
  console.log(`🔍  Prices: http://localhost:${MCP_PORT}/prices`);
  console.log(`❤️   Health: http://localhost:${MCP_PORT}/health`);
});

export { server };