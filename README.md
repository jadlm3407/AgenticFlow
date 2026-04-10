# ⬡ AgenticFlow

**Autonomous BSV Micropayment Agent Network**  
*Open Run Agentic Pay 2026 Hackathon Submission*

---

## Live Verification

All transactions produced by AgenticFlow are auditable on-chain. Every TX carries an `OP_RETURN` payload with the prefix `AGFLOW26` — searchable on WhatsOnChain.

```
Engine wallet (all TXs):  https://whatsonchain.com/address/<ENGINE_AGENT_ADDRESS>
OP_RETURN search:         https://whatsonchain.com  →  search "AGFLOW26"
```

> Fill in `ENGINE_AGENT_ADDRESS` from your `.env` before the demo and add the live link here.

---

## Overview

AgenticFlow is a fully autonomous multi-agent system where AI agents with independent BSV wallets discover each other, negotiate prices, and execute micropayments on-chain — with zero human interaction after launch.

Three agents operate continuously:

- **SkillsAgent** — marketplace MCP server exposing AI tools with BSV price tags
- **ClientAgent** — autonomous buyer that discovers tools, negotiates, pays on-chain, and consumes services
- **EngineAgent** — high-frequency TX engine driving 20 parallel UTXO chains at 17+ TPS

```
┌─────────────────────────────────────────────────────────┐
│                    orchestrator.ts                      │
│   Autonomous boot → wallet checks → UTXO fan-out       │
└──────┬──────────────────┬───────────────────────────────┘
       │                  │
┌──────▼──────┐    ┌──────▼──────┐    ┌──────────────────┐
│skills-server│    │client-agent │    │   tx-engine      │
│  MCP Server │◄──►│  Buyer loop │    │  20 UTXO chains  │
│             │    │             │    │  17+ TPS         │
│ Tools with  │    │ Discover →  │    │  OP_RETURN data  │
│ BSV prices  │    │ Negotiate → │    └──────────────────┘
│             │    │ Pay → Use   │
└─────────────┘    └─────────────┘
       │                  │                   │
       └──────────────────▼───────────────────┘
              Next.js UI  ←  SSE stream
          TPS gauge · chain grid · TX log · agent activity
```

---

## Hackathon Requirements

| Requirement | Implementation |
|---|---|
| ≥ 2 agents with independent BSV wallets | SkillsAgent + ClientAgent + EngineAgent — 3 separate WIF keys |
| Autonomous agent discovery | MCP `price://*` resource; `McpClient.connect()` every 200ms |
| Price negotiation | Client fetches price schedule, accepts only if `price ≤ MAX_PRICE_SATS` |
| On-chain micropayment before service | `buildPaymentTx()` → broadcast → SPV verify → execute |
| 1.5M transactions / 24h | 20 parallel UTXO chains × ~1 TX/s = 17+ TPS sustained |
| 100% autonomous — no human triggers | `setInterval` loop; orchestrator wires everything at startup |
| Network error resilience | Exponential retry (100→200→400ms), stale UTXO cache fallback, 30s watchdog |
| Verifiable on-chain transactions | Every TX: `OP_RETURN AGFLOW26 <taskHash> <timestamp>` |

---

## Project Structure

```
agenticflow/
├── orchestrator.ts              # Single entry point — boots everything
├── package.json
├── tsconfig.json
├── .env.example                 # All required environment variables
│
├── agents/
│   ├── skills-server.ts         # MCP server: exposes tools with BSV prices
│   └── client-agent.ts          # Autonomous buyer: discover → negotiate → pay → use
│
├── engine/
│   └── tx-engine.ts             # High-frequency UTXO chain engine (17+ TPS)
│
├── scripts/
│   ├── generate-wallets.ts      # One-time wallet generator
│   └── preflight.ts             # Pre-launch validation checklist
│
└── ui/
    └── app/
        ├── page.tsx             # Next.js dashboard: TPS gauge, chain grid, TX log
        └── api/sse/route.ts     # SSE bridge: Node.js EventEmitter → browser
```

---

## Quick Start

### 1. Install dependencies

```bash
git clone https://github.com/YOUR_USERNAME/AgenticFlow.git
cd AgenticFlow
npm install
```

### 2. Generate wallets

```bash
npm run generate-wallets
```

This prints three WIF keys and addresses. Copy the output directly into `.env`.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — the only values you must change are marked `← CHANGE THIS`:

```env
ARC_API_KEY=your_real_key_from_taal        # ← get at console.taal.com
AGENT_ID=AGFLOW26                          # ← your on-chain label (max 16 chars)

SKILLS_AGENT_WIF=L...                      # ← from generate-wallets output
SKILLS_AGENT_ADDRESS=1...
CLIENT_AGENT_WIF=L...
CLIENT_AGENT_ADDRESS=1...
ENGINE_AGENT_WIF=L...
ENGINE_AGENT_ADDRESS=1...

TREASURY_TX_HEX=0100000001...              # ← raw TX that funded ENGINE_AGENT_ADDRESS
TREASURY_VOUT=0
TREASURY_SATS=2500000
```

### 4. Fund wallets

| Wallet | Minimum | Purpose |
|---|---|---|
| `ENGINE_AGENT_ADDRESS` | 2,500,000 sats (0.025 BSV) | Fan-out to 20 UTXO chains |
| `CLIENT_AGENT_ADDRESS` | 100,000 sats (0.001 BSV) | Negotiation micropayments |
| `SKILLS_AGENT_ADDRESS` | None needed | Receives payments only |

After funding the EngineAgent, get the raw TX hex from WhatsOnChain:
```
https://whatsonchain.com/address/<ENGINE_AGENT_ADDRESS>
```
Click the funding TX → click "Raw Tx" → copy the hex into `TREASURY_TX_HEX`.

### 5. Run preflight check

```bash
npm run preflight
```

This verifies wallets, balances, ARC connectivity, and MCP reachability before you launch. Fix any `❌` before proceeding.

### 6. Launch

```bash
# Full autonomous system
npm run dev

# Dashboard UI (separate terminal)
npm run ui:dev
# → open http://localhost:3000
```

---

## Testing on Testnet First (Recommended)

Before using real BSV, test on BSV testnet — transactions are free:

```env
ARC_API_URL=https://arc-testnet.taal.com
```

Get free testnet sats: `https://faucet.bitcoincloud.net`

Verify testnet TXs at: `https://test.whatsonchain.com`

Once everything works on testnet, switch back to mainnet and fund the wallets.

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `ARC_API_URL` | `https://arc.taal.com` | BSV ARC broadcaster (mainnet) |
| `ARC_API_KEY` | — | ARC authentication key |
| `AGENT_ID` | `AGFLOW26` | Label embedded in every OP_RETURN |
| `MCP_PORT` | `3100` | SkillsAgent MCP server port |
| `SKILLS_MCP_URL` | `http://localhost:3100` | ClientAgent connects here |
| `MAX_PRICE_SATS` | `500` | ClientAgent rejects tools above this price |
| `MIN_BALANCE_SATS` | `5000` | ClientAgent pauses below this wallet balance |
| `CHAIN_COUNT` | `20` | Parallel UTXO chains |
| `TARGET_TPS` | `17.5` | Target transactions per second |
| `CHAIN_FUNDING_SATS` | `100000` | Sats per chain at bootstrap |
| `MAX_CHAIN_DEPTH` | `5000` | Chain retired after this many TXs |
| `BROADCAST_CONCURRENCY` | `50` | Max simultaneous ARC broadcasts |
| `LOG_EVENTS` | `0` | Set to `1` for verbose event logging |

---

## Architecture

### Payment flow (per negotiation cycle)

```
ClientAgent                          SkillsAgent
    │                                     │
    │── GET price://*  ──────────────────►│
    │◄─ { address, prices: {tool: sats} }─│
    │                                     │
    │  [build & sign TX paying address]   │
    │                                     │
    │── callTool(tool, { payment_tx_hex })►│
    │                           [verify TX on-chain via SPV]
    │                           [execute skill]
    │◄─ { txid, result }─────────────────│
```

### UTXO chain fan-out (engine)

```
Treasury UTXO (1 input)
        │
        ▼  bootstrapChains()
┌───────────────────────────────┐
│  Fan-out TX: 1 → 20 outputs   │
└─┬────┬────┬──── ... ────┬─────┘
  │    │    │             │
  ▼    ▼    ▼             ▼
CH-0 CH-1 CH-2   ...   CH-19
  │
  ▼  TX1: input=CH-0[vout:0] → output[change] + OP_RETURN
  ▼  TX2: input=TX1[vout:0]  → output[change] + OP_RETURN
  ▼  TX3: ...  (self-funding, no UTXO lookup needed)
```

### OP_RETURN structure (every TX is auditable)

```
OP_FALSE OP_RETURN
  "AGFLOW26"          ← 8-byte protocol prefix (hex: 4147464c4f573236)
  <taskHash>          ← sha256 of task data (32 bytes)
  <timestamp>         ← Unix ms as uint64 big-endian (8 bytes)
```

---

## Performance

At 17.5 TPS sustained for 24 hours: `17.5 × 86,400 = 1,512,000 transactions`.

This is achievable on BSV because:
- No artificial block size cap — large blocks accommodate high throughput
- UTXO chain fan-out eliminates per-TX UTXO lookup latency
- 1 sat/byte fee floor (~$0.0000005 per TX at current BSV price)
- `Promise.allSettled` batching sends 50 TXs concurrently without self-DDoS
- Adaptive rate control skips delays to catch up if engine falls behind target

---

## Dependencies

| Package | Role |
|---|---|
| `@bsv/sdk` | Raw transaction construction, P2PKH signing, OP_RETURN scripting |
| `@bsv/simple` | Wallet UTXO management, SPV proof verification |
| `@bsv/simple-mcp` | MCP server/client for agent discovery and paid tool calls |
| `next` | Dashboard UI and SSE API route |

---

## License

MIT

---

*Built with ⬡ BSV Blockchain · Open Run Agentic Pay 2026*
