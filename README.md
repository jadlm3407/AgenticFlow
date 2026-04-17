# ⬡ AgenticFlow

**Autonomous BSV Micropayment Agent Network**
*Open Run Agentic Pay 2026 Hackathon Submission*

---

## Live Verification

Every transaction is auditable on-chain:
```
Engine TXs:    https://whatsonchain.com/address/<ENGINE_AGENT_ADDRESS>
OP_RETURN:     Search "AGFLOW26" on https://whatsonchain.com
```

---

## Standards Implemented

| Standard | Description | Role in AgenticFlow |
|---|---|---|
| **BRC-100** | Vendor-neutral wallet-to-app interface | Wallet key management, UTXO handling |
| **BRC-105** | HTTP Service Monetization Framework | Payment-gated tool calls (pay → execute) |
| **go-wallet-toolbox** | BSV BRC-100 wallet reference (Go) | Architecture reference for wallet design |
| **@bsv/wallet-toolbox** | TypeScript BRC-100 wallet toolkit | Wallet patterns used in all three agents |
| **MetaNet Desktop** | BRC-100 wallet (port 2121) | Compatible onboarding reference |

---

## Overview

Three autonomous agents operate continuously with independent BSV wallets:

```
┌─────────────────────────────────────────────────────────┐
│                    orchestrator.ts                      │
│   Autonomous boot → BRC-100 wallet checks → UTXO setup  │
└──────┬──────────────────┬───────────────────────────────┘
       │                  │
┌──────▼──────┐    ┌──────▼──────┐    ┌──────────────────┐
│skills-server│    │client-agent │    │   tx-engine      │
│ BRC-105     │◄──►│ BRC-105     │    │  20 UTXO chains  │
│ MCP Server  │    │ Buyer loop  │    │  17+ TPS         │
│             │    │             │    │  OP_RETURN data  │
│ Price →     │    │ Discover →  │    └──────────────────┘
│ Pay verify  │    │ Negotiate → │
│ → Execute   │    │ Pay → Use   │
└─────────────┘    └─────────────┘
       └──────────────────▼────────────────────┘
              Next.js UI ← SSE stream
          TPS gauge · chain grid · TX log
```

---

## Hackathon Requirements

| Requirement | Implementation |
|---|---|
| ≥ 2 agents with independent BSV wallets | SkillsAgent + ClientAgent + EngineAgent |
| Autonomous agent discovery | MCP resource `GET /prices` every 200ms |
| Price negotiation | Client accepts only if `price ≤ MAX_PRICE_SATS` |
| On-chain micropayment before service | BRC-105: build TX → verify on ARC → execute |
| 1.5M transactions / 24h | 20 UTXO chains × ~1 TX/s = 17+ TPS |
| 100% autonomous | `setInterval` loop, no human triggers ever |
| Network error resilience | Exponential retry, stale UTXO cache, 30s watchdog |
| Verifiable on-chain TXs | Every TX: `OP_RETURN AGFLOW26 <hash> <timestamp>` |

---

## Project Structure

```
agenticflow/
├── orchestrator.ts              # Boot: wallet checks → chains → agents
├── package.json
├── tsconfig.json
├── .env.example
├── agents/
│   ├── skills-server.ts         # BRC-105 MCP server (tool seller)
│   └── client-agent.ts          # BRC-105 autonomous buyer
├── engine/
│   └── tx-engine.ts             # UTXO chain fan-out (17+ TPS)
├── scripts/
│   ├── generate-wallets.ts      # One-time BRC-100 wallet generator
│   └── preflight.ts             # Pre-launch validation
└── ui/
    └── app/
        ├── page.tsx             # Next.js live dashboard
        └── api/sse/route.ts     # SSE bridge to browser
```

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Generate wallets
npm run generate-wallets

# 3. Configure
cp .env.example .env
# Fill in your values

# 4. Validate
npm run preflight

# 5. Launch
npm run dev
```

---

## ARC Broadcaster

AgenticFlow uses **GorillaPool ARC** by default — no API key required:

```env
ARC_API_URL=https://arc.gorillapool.io
ARC_API_KEY=none
```

Alternative broadcasters:

| Broadcaster | URL | API Key |
|---|---|---|
| GorillaPool (default) | `https://arc.gorillapool.io` | Not required |
| WhatsOnChain | `https://arc.whatsonchain.com` | Not required |
| TAAL | `https://arc.taal.com` | Required (register at platform.taal.com) |

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@bsv/sdk` | ^2.0.5 | TX construction, P2PKH signing, OP_RETURN |
| `@bsv/wallet-toolbox` | ^2.1.19 | BRC-100 wallet patterns, key derivation |
| `@modelcontextprotocol/sdk` | ^1.10.2 | MCP server/client (agent discovery) |
| `axios` | ^1.7.2 | UTXO queries, ARC broadcast |
| `zod` | ^3.23.8 | MCP tool schema validation |
| `next` | ^16.2.3 | Dashboard UI |

---

## Performance

At 17.5 TPS × 86,400 seconds = **1,512,000 transactions/day**

- BSV has no block size cap — handles 17+ TPS comfortably
- UTXO chain fan-out: 20 independent chains, no UTXO lookup between TXs
- 1 sat/byte fee (~$0.0000005 per TX)
- 50 concurrent ARC broadcasts with `Promise.allSettled`

---

## License

MIT · Built for Open Run Agentic Pay 2026 · BSV Blockchain
