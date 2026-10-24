import { asc, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import type { RunDetail, RunEvent } from "@/lib/contract"
import { simNow } from "@/lib/agent/clock"
import { toRun } from "@/lib/agent/store"
import { ringRuns, ringSteps } from "@/lib/ring-schema"

export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params
  const [run] = await db.select().from(ringRuns).where(eq(ringRuns.id, runId))
  if (!run) return NextResponse.json({ error: "Run not found", code: "NOT_FOUND" }, { status: 404 })
  const steps = await db.select().from(ringSteps).where(eq(ringSteps.runId, runId)).orderBy(asc(ringSteps.seq))
  const detail: RunDetail & { now: string } = { now: await simNow(), run: toRun(run), events: steps.map((s) => s.event as RunEvent) }
  return NextResponse.json(detail)
}
