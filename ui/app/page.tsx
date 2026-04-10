"use client";

/**
 * AgenticFlow — Live Dashboard
 * Connects to the AgenticFlow SSE stream and renders:
 *   - Real-time TPS meter and 24h projection
 *   - UTXO chain health grid
 *   - Agent negotiation activity log
 *   - Verifiable on-chain TX links (WhatsOnChain)
 */

import { useEffect, useRef, useState, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TxEvent {
  id:        string;
  chainId:   number;
  txid:      string;
  success:   boolean;
  timestamp: string;
}

interface AgentEvent {
  id:        string;
  type:      "discovered" | "negotiated" | "paid" | "executed" | "rejected" | "error";
  tool:      string;
  price?:    number;
  txid?:     string;
  result?:   unknown;
  reason?:   string;
  timestamp: string;
}

interface EngineStats {
  sent:        number;
  confirmed:   number;
  failed:      number;
  tps:         number;
  chainDepths: number[];
  startTime:   number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WOC_URL  = "https://whatsonchain.com/tx/";
const MAX_LOG  = 200;
const TARGET   = 1_500_000;
const SECS_DAY = 86_400;

// ─── Utility ──────────────────────────────────────────────────────────────────

function shortTxid(txid: string) {
  return `${txid.slice(0, 8)}…${txid.slice(-6)}`;
}

function fmtNum(n: number) {
  return n.toLocaleString("en-US");
}

const EVENT_ICONS: Record<AgentEvent["type"], string> = {
  discovered: "🔍",
  negotiated: "🤝",
  paid:       "💸",
  executed:   "✅",
  rejected:   "❌",
  error:      "💥",
};

const EVENT_COLORS: Record<AgentEvent["type"], string> = {
  discovered: "#64d2ff",
  negotiated: "#ffd60a",
  paid:       "#30d158",
  executed:   "#32ade6",
  rejected:   "#ff6b6b",
  error:      "#ff453a",
};

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useSSE<T>(url: string, eventName: string, maxItems: number) {
  const [items, setItems] = useState<T[]>([]);
  const idRef = useRef(0);

  useEffect(() => {
    const es = new EventSource(url);
    es.addEventListener(eventName, (e: MessageEvent) => {
      const data = JSON.parse(e.data) as Omit<T, "id">;
      setItems(prev => [
        { ...data, id: String(idRef.current++) } as T,
        ...prev.slice(0, maxItems - 1),
      ]);
    });
    es.onerror = () => setTimeout(() => es.close(), 5000);
    return () => es.close();
  }, [url, eventName, maxItems]);

  return items;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TPSGauge({ tps, sent, startTime }: { tps: number; sent: number; startTime: number }) {
  const elapsed    = (Date.now() - startTime) / 1000;
  const projected  = elapsed > 0 ? Math.round(sent * (SECS_DAY / elapsed)) : 0;
  const pct        = Math.min(100, (projected / TARGET) * 100);
  const arc        = ((pct / 100) * 251.2).toFixed(1); // circumference of r=40 circle

  return (
    <div style={styles.gaugeCard}>
      <div style={styles.gaugeTitle}>THROUGHPUT</div>
      <div style={{ position: "relative", width: 120, height: 120, margin: "0 auto" }}>
        <svg width="120" height="120" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="60" cy="60" r="40" fill="none" stroke="#1c1c1e" strokeWidth="10" />
          <circle
            cx="60" cy="60" r="40" fill="none"
            stroke={pct > 80 ? "#30d158" : pct > 40 ? "#ffd60a" : "#ff6b6b"}
            strokeWidth="10"
            strokeDasharray={`${arc} 251.2`}
            strokeLinecap="round"
            style={{ transition: "stroke-dasharray 0.5s ease" }}
          />
        </svg>
        <div style={styles.gaugeCenterLabel}>
          <div style={styles.tpsNumber}>{tps.toFixed(1)}</div>
          <div style={styles.tpsUnit}>TPS</div>
        </div>
      </div>
      <div style={styles.gaugeStats}>
        <div><span style={styles.statLabel}>SENT</span><span style={styles.statValue}>{fmtNum(sent)}</span></div>
        <div><span style={styles.statLabel}>PROJ/24H</span><span style={styles.statValue}>{fmtNum(projected)}</span></div>
        <div><span style={styles.statLabel}>TARGET</span><span style={styles.statValue}>{fmtNum(TARGET)}</span></div>
        <div style={{ gridColumn: "1/-1" }}>
          <div style={styles.progressBar}>
            <div style={{ ...styles.progressFill, width: `${pct}%`, background: pct > 80 ? "#30d158" : "#ffd60a" }} />
          </div>
          <div style={{ ...styles.statLabel, textAlign: "right", marginTop: 2 }}>{pct.toFixed(1)}%</div>
        </div>
      </div>
    </div>
  );
}

function ChainGrid({ depths }: { depths: number[] }) {
  return (
    <div style={styles.chainCard}>
      <div style={styles.gaugeTitle}>UTXO CHAINS ({depths.length})</div>
      <div style={styles.chainGrid}>
        {depths.map((d, i) => {
          const heat = Math.min(1, d / 5000);
          const bg   = `hsl(${120 - heat * 120}, 80%, 35%)`;
          return (
            <div key={i} title={`Chain ${i}: depth ${d}`} style={{ ...styles.chainCell, background: bg }}>
              <span style={styles.chainCellNum}>{i}</span>
            </div>
          );
        })}
      </div>
      <div style={styles.chainLegend}>
        <span style={{ color: "#30d158" }}>■ new</span>
        <span style={{ color: "#ffd60a" }}>■ mid</span>
        <span style={{ color: "#ff6b6b" }}>■ deep</span>
      </div>
    </div>
  );
}

function TxRow({ tx }: { tx: TxEvent }) {
  return (
    <div style={{ ...styles.txRow, opacity: tx.success ? 1 : 0.5 }}>
      <span style={{ ...styles.chainBadge, background: `hsl(${(tx.chainId * 37) % 360}, 60%, 35%)` }}>
        CH-{tx.chainId.toString().padStart(2, "0")}
      </span>
      <a
        href={`${WOC_URL}${tx.txid}`}
        target="_blank"
        rel="noopener noreferrer"
        style={styles.txLink}
      >
        {shortTxid(tx.txid)}
      </a>
      <span style={{ color: tx.success ? "#30d158" : "#ff453a", fontSize: 11, fontFamily: "monospace" }}>
        {tx.success ? "✓ SEEN" : "✗ FAIL"}
      </span>
      <span style={styles.txTime}>{new Date(tx.timestamp).toLocaleTimeString()}</span>
    </div>
  );
}

function AgentRow({ event }: { event: AgentEvent }) {
  return (
    <div style={styles.agentRow}>
      <span style={{ fontSize: 16 }}>{EVENT_ICONS[event.type]}</span>
      <span style={{ color: EVENT_COLORS[event.type], fontFamily: "monospace", fontSize: 11, fontWeight: 700 }}>
        {event.type.toUpperCase()}
      </span>
      <span style={styles.toolTag}>{event.tool}</span>
      {event.price !== undefined && (
        <span style={styles.priceTag}>{event.price} sats</span>
      )}
      {event.txid && (
        <a href={`${WOC_URL}${event.txid}`} target="_blank" rel="noopener noreferrer" style={styles.txLink}>
          {shortTxid(event.txid)}
        </a>
      )}
      {event.reason && (
        <span style={{ color: "#8e8e93", fontSize: 10, fontFamily: "monospace" }}>{event.reason}</span>
      )}
      <span style={styles.txTime}>{new Date(event.timestamp).toLocaleTimeString()}</span>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const [stats,  setStats]  = useState<EngineStats>({ sent: 0, confirmed: 0, failed: 0, tps: 0, chainDepths: Array(20).fill(0), startTime: Date.now() });
  const txEvents    = useSSE<TxEvent>("/api/sse", "tx", MAX_LOG);
  const agentEvents = useSSE<AgentEvent>("/api/sse", "agent", MAX_LOG);

  useEffect(() => {
    const es = new EventSource("/api/sse");
    es.addEventListener("stats", (e: MessageEvent) => setStats(JSON.parse(e.data)));
    return () => es.close();
  }, []);

  const [activeTab, setActiveTab] = useState<"tx" | "agent">("agent");

  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.logo}>
          <div style={styles.logoMark}>⬡</div>
          <div>
            <div style={styles.logoName}>AgenticFlow</div>
            <div style={styles.logoSub}>BSV Autonomous Payment Network</div>
          </div>
        </div>
        <div style={styles.headerRight}>
          <div style={styles.liveDot} />
          <span style={styles.liveLabel}>LIVE</span>
        </div>
      </header>

      {/* Top metrics */}
      <div style={styles.metricsRow}>
        <TPSGauge tps={stats.tps} sent={stats.sent} startTime={stats.startTime} />
        <ChainGrid depths={stats.chainDepths} />
        <div style={styles.counterCard}>
          <div style={styles.gaugeTitle}>TOTALS</div>
          <div style={styles.bigCounter}>{fmtNum(stats.sent)}</div>
          <div style={styles.counterLabel}>Transactions Sent</div>
          <div style={{ marginTop: 16 }}>
            <div style={styles.counterRow}>
              <span style={styles.statLabel}>CONFIRMED</span>
              <span style={{ color: "#30d158", fontFamily: "monospace" }}>{fmtNum(stats.confirmed)}</span>
            </div>
            <div style={styles.counterRow}>
              <span style={styles.statLabel}>FAILED</span>
              <span style={{ color: "#ff453a", fontFamily: "monospace" }}>{fmtNum(stats.failed)}</span>
            </div>
            <div style={styles.counterRow}>
              <span style={styles.statLabel}>SUCCESS RATE</span>
              <span style={{ color: "#ffd60a", fontFamily: "monospace" }}>
                {stats.sent > 0 ? ((stats.sent - stats.failed) / stats.sent * 100).toFixed(2) : "—"}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Log panel */}
      <div style={styles.logPanel}>
        <div style={styles.logHeader}>
          <div style={styles.logTabs}>
            <button style={{ ...styles.tab, ...(activeTab === "agent" ? styles.tabActive : {}) }} onClick={() => setActiveTab("agent")}>
              🤖 AGENT ACTIVITY
            </button>
            <button style={{ ...styles.tab, ...(activeTab === "tx" ? styles.tabActive : {}) }} onClick={() => setActiveTab("tx")}>
              ⛓ TX LOG
            </button>
          </div>
          <span style={styles.logCount}>
            {activeTab === "agent" ? agentEvents.length : txEvents.length} entries
          </span>
        </div>

        <div style={styles.logBody}>
          {activeTab === "agent"
            ? agentEvents.map(e => <AgentRow key={e.id} event={e} />)
            : txEvents.map(t => <TxRow key={t.id} tx={t} />)
          }
          {(activeTab === "agent" ? agentEvents : txEvents).length === 0 && (
            <div style={styles.emptyState}>Waiting for activity…</div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer style={styles.footer}>
        <span>AgenticFlow v1.0 · Open Run Agentic Pay 2026</span>
        <span>BSV Blockchain · @bsv/sdk · @bsv/simple-mcp</span>
      </footer>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight:   "100vh",
    background:  "#000000",
    color:       "#f2f2f7",
    fontFamily:  "'SF Mono', 'JetBrains Mono', 'Fira Code', monospace",
    display:     "flex",
    flexDirection: "column",
    gap:         16,
    padding:     "16px 20px",
  },
  header: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    borderBottom:   "1px solid #1c1c1e",
    paddingBottom:  12,
  },
  logo: { display: "flex", alignItems: "center", gap: 12 },
  logoMark: { fontSize: 28, color: "#ffd60a" },
  logoName: { fontSize: 20, fontWeight: 700, letterSpacing: 2, color: "#f2f2f7" },
  logoSub:  { fontSize: 10, color: "#636366", letterSpacing: 1 },
  headerRight: { display: "flex", alignItems: "center", gap: 8 },
  liveDot: {
    width: 8, height: 8, borderRadius: "50%",
    background: "#30d158",
    boxShadow:  "0 0 8px #30d158",
    animation:  "pulse 1.5s ease-in-out infinite",
  },
  liveLabel: { fontSize: 11, color: "#30d158", fontWeight: 700, letterSpacing: 2 },

  metricsRow: {
    display:    "grid",
    gridTemplateColumns: "200px 1fr 220px",
    gap:        12,
  },

  gaugeCard: {
    background:   "#0a0a0a",
    border:       "1px solid #1c1c1e",
    borderRadius: 12,
    padding:      16,
  },
  gaugeTitle: {
    fontSize:      9,
    letterSpacing: 2,
    color:         "#636366",
    marginBottom:  12,
    fontWeight:    700,
  },
  gaugeCenterLabel: {
    position:  "absolute",
    top: "50%", left: "50%",
    transform: "translate(-50%, -50%)",
    textAlign: "center",
  },
  tpsNumber: { fontSize: 22, fontWeight: 700, color: "#f2f2f7" },
  tpsUnit:   { fontSize: 9, color: "#636366", letterSpacing: 2 },
  gaugeStats: {
    display:             "grid",
    gridTemplateColumns: "1fr 1fr",
    gap:                 6,
    marginTop:           12,
  },
  statLabel: { fontSize: 9, color: "#636366", letterSpacing: 1, display: "block" },
  statValue: { fontSize: 13, color: "#f2f2f7", fontWeight: 700 },
  progressBar: { height: 4, background: "#1c1c1e", borderRadius: 2, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 2, transition: "width 1s ease" },

  chainCard: {
    background:   "#0a0a0a",
    border:       "1px solid #1c1c1e",
    borderRadius: 12,
    padding:      16,
    overflow:     "hidden",
  },
  chainGrid: {
    display:             "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(36px, 1fr))",
    gap:                 4,
    marginTop:           8,
  },
  chainCell: {
    width:        36,
    height:       36,
    borderRadius: 6,
    display:      "flex",
    alignItems:   "center",
    justifyContent: "center",
    transition:   "background 0.5s ease",
    cursor:       "help",
  },
  chainCellNum: { fontSize: 9, color: "rgba(255,255,255,0.6)", fontWeight: 700 },
  chainLegend: {
    display:  "flex",
    gap:      16,
    fontSize: 9,
    marginTop: 8,
    color:    "#636366",
    letterSpacing: 1,
  },

  counterCard: {
    background:   "#0a0a0a",
    border:       "1px solid #1c1c1e",
    borderRadius: 12,
    padding:      16,
  },
  bigCounter: { fontSize: 32, fontWeight: 700, color: "#ffd60a", letterSpacing: -1 },
  counterLabel: { fontSize: 9, color: "#636366", letterSpacing: 2 },
  counterRow: {
    display:        "flex",
    justifyContent: "space-between",
    alignItems:     "center",
    padding:        "5px 0",
    borderBottom:   "1px solid #1c1c1e",
  },

  logPanel: {
    flex:         1,
    background:   "#0a0a0a",
    border:       "1px solid #1c1c1e",
    borderRadius: 12,
    display:      "flex",
    flexDirection: "column",
    overflow:     "hidden",
  },
  logHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "10px 16px",
    borderBottom:   "1px solid #1c1c1e",
  },
  logTabs: { display: "flex", gap: 4 },
  tab: {
    background:   "transparent",
    border:       "1px solid #2c2c2e",
    color:        "#636366",
    padding:      "5px 12px",
    borderRadius: 6,
    cursor:       "pointer",
    fontSize:     11,
    letterSpacing: 0.5,
    fontFamily:   "inherit",
    fontWeight:   600,
  },
  tabActive: {
    background: "#1c1c1e",
    color:      "#f2f2f7",
    borderColor: "#3a3a3c",
  },
  logCount: { fontSize: 10, color: "#636366" },
  logBody: {
    flex:       1,
    overflowY:  "auto",
    padding:    "8px 0",
  },

  txRow: {
    display:     "flex",
    alignItems:  "center",
    gap:         10,
    padding:     "6px 16px",
    borderBottom: "1px solid #111",
    fontSize:    11,
    transition:  "background 0.2s",
  },
  chainBadge: {
    padding:      "2px 6px",
    borderRadius: 4,
    fontSize:     9,
    fontWeight:   700,
    letterSpacing: 1,
    color:        "#f2f2f7",
    flexShrink:   0,
  },
  txLink: {
    color:          "#64d2ff",
    textDecoration: "none",
    fontFamily:     "monospace",
    fontSize:       11,
    flex:           1,
    overflow:       "hidden",
    textOverflow:   "ellipsis",
    whiteSpace:     "nowrap",
  },
  txTime: { color: "#636366", fontSize: 10, flexShrink: 0 },

  agentRow: {
    display:     "flex",
    alignItems:  "center",
    gap:         8,
    padding:     "7px 16px",
    borderBottom: "1px solid #111",
    fontSize:    11,
    flexWrap:    "wrap",
  },
  toolTag: {
    background:   "#1c1c1e",
    padding:      "2px 8px",
    borderRadius: 4,
    fontSize:     10,
    color:        "#aeaeb2",
    fontWeight:   600,
  },
  priceTag: {
    background:   "#2c2c2e",
    padding:      "2px 8px",
    borderRadius: 4,
    fontSize:     10,
    color:        "#ffd60a",
    fontWeight:   700,
  },

  emptyState: {
    textAlign: "center",
    color:     "#3a3a3c",
    padding:   40,
    fontSize:  12,
    letterSpacing: 2,
  },

  footer: {
    display:        "flex",
    justifyContent: "space-between",
    fontSize:       9,
    color:          "#3a3a3c",
    letterSpacing:  1,
    paddingTop:     8,
    borderTop:      "1px solid #1c1c1e",
  },
};
