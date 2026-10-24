// POST → application/x-ndjson, one RunEvent per line, ending with run_ended.
import { SeverityNumber } from "@opentelemetry/api-logs"
import { after, NextResponse } from "next/server"
import { ringLogsLogger, ringLogsProvider } from "@/instrumentation"
import type { RunEvent, RunRequest } from "@/lib/contract"
import { liveRun, replay, runRing } from "@/lib/agent/loop"
import { loadOrder } from "@/lib/present/load"

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = (await request.json().catch(() => ({}))) as Partial<RunRequest>
  if (!(await loadOrder(id))) return NextResponse.json({ error: "Order not found", code: "NOT_FOUND" }, { status: 404 })
  if (body.trigger !== "replay" && (await liveRun(id))) return NextResponse.json({ error: "Ringo is already working on this order.", code: "RUN_LIVE" }, { status: 409 })
  const runMode = body.trigger === "replay" ? "replay" : "operator"
  ringLogsLogger?.emit({
    body: "ring_run_stream_started",
    severityNumber: SeverityNumber.INFO,
    attributes: { "ring.run_mode": runMode },
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // If the browser goes away the run still finishes; we just stop writing.
      const send = (e: RunEvent) => { try { controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`)) } catch {} }
      let completed = false
      try {
        if (body.trigger === "replay") await replay(id, send)
        else await runRing({ orderId: id, trigger: "operator", message: body.message?.trim() || null, onEvent: send })
        completed = true
      } finally {
        ringLogsLogger?.emit({
          body: "ring_run_stream_finished",
          severityNumber: completed ? SeverityNumber.INFO : SeverityNumber.ERROR,
          attributes: { "ring.run_mode": runMode, completed },
        })
        try { controller.close() } catch {}
      }
    },
  })
  after(async () => {
    await ringLogsProvider?.forceFlush()
  })
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } })
}
