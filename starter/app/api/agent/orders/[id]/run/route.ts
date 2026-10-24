// POST live run → 202 {runId} once started (poll GET /api/agent/runs/[runId]?after=<seq>), or {runId, events} if it ended at once.
// POST replay → application/x-ndjson, one RunEvent per line, ending with run_ended.
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

  const finished = (completed: boolean) => ringLogsLogger?.emit({
    body: "ring_run_stream_finished",
    severityNumber: completed ? SeverityNumber.INFO : SeverityNumber.ERROR,
    attributes: { "ring.run_mode": runMode, completed },
  })

  if (body.trigger !== "replay") {
    // Live runs take 35-50 s, longer than a proxy's per-request cap (Matrix OS: 30 s). So the run goes on
    // in the background, writing ring_steps, and this answers as soon as it has started; the panel then
    // polls GET /api/agent/runs/[runId]?after=<seq>. If it ends before starting (offline), its events come back here.
    const early: RunEvent[] = []
    let answer!: (r: Response) => void
    const answered = new Promise<Response>((r) => { answer = r })
    const run = runRing({
      orderId: id, trigger: "operator", message: body.message?.trim() || null,
      onEvent: (e) => {
        if (e.type === "run_started") answer(NextResponse.json({ runId: e.runId }, { status: 202 }))
        early.push(e)
        if (e.type === "run_ended") answer(NextResponse.json({ runId: e.runId, events: early }))
      },
    }).then(() => finished(true), (e) => {
      finished(false)
      answer(NextResponse.json({ error: e instanceof Error ? e.message : "Ringo could not start." }, { status: 500 }))
    })
    after(async () => { await run; await ringLogsProvider?.forceFlush() })
    return answered
  }

  // Replay is short (300 ms per recorded event, under 25 s), so it still streams.
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: RunEvent) => { try { controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`)) } catch {} }
      let completed = false
      try {
        await replay(id, send)
        completed = true
      } finally {
        finished(completed)
        try { controller.close() } catch {}
      }
    },
  })
  after(async () => {
    await ringLogsProvider?.forceFlush()
  })
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } })
}
