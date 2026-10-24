import { and, asc, eq, gt } from "drizzle-orm"
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import type { RunDetail, RunEvent } from "@/lib/contract"
import { simNow } from "@/lib/agent/clock"
import { toRun } from "@/lib/agent/store"
import { ringRuns, ringSteps } from "@/lib/ring-schema"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params
  const [run] = await db.select().from(ringRuns).where(eq(ringRuns.id, runId))
  if (!run) return NextResponse.json({ error: "Run not found", code: "NOT_FOUND" }, { status: 404 })
  // ?after=<seq> returns only the steps after that seq (the run panel polls with it).
  const after = Number(new URL(request.url).searchParams.get("after") ?? -1)
  const steps = await db.select().from(ringSteps).where(and(eq(ringSteps.runId, runId), gt(ringSteps.seq, Number.isFinite(after) ? after : -1))).orderBy(asc(ringSteps.seq))
  const detail: RunDetail & { now: string } = { now: await simNow(), run: toRun(run), events: steps.map((s) => s.event as RunEvent) }
  return NextResponse.json(detail)
}
