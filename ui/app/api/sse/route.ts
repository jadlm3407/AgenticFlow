/**
 * AgenticFlow — Server-Sent Events API Route
 * Bridges the Node.js event buses (agentBus + engineBus) to the browser.
 * Streams three event types: "tx", "agent", "stats"
 *
 * File: /app/api/sse/route.ts  (Next.js App Router)
 */

import { NextRequest } from "next/server";
import { agentBus }    from "@/agents/client-agent";
import { engineBus }   from "@/engine/tx-engine";

export const dynamic   = "force-dynamic";
export const runtime   = "nodejs";

export async function GET(_req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      function send(eventName: string, data: unknown) {
        const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Client disconnected
        }
      }

      // Send heartbeat every 15 s to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      // Forward engine TX events
      const onTx = (data: unknown) => send("tx", { ...data as object, timestamp: new Date().toISOString() });
      engineBus.on("tx", onTx);

      // Forward engine stats
      const onStats = (data: unknown) => send("stats", data);
      engineBus.on("stats", onStats);

      // Forward agent negotiation events
      const onAgent = (data: unknown) => send("agent", data);
      agentBus.on("event", onAgent);

      // Cleanup on close
      const cleanup = () => {
        clearInterval(heartbeat);
        engineBus.off("tx",    onTx);
        engineBus.off("stats", onStats);
        agentBus.off("event",  onAgent);
      };

      _req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
