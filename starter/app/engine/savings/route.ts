// GET: the time Ringo saved today (sim clock, Helsinki day). POST {estimates}: a person sets the
// per-step minutes. The formula lives in lib/savings.ts; this only gathers today's rows.
import { eq, inArray } from "drizzle-orm"
import { NextResponse } from "next/server"
import type { CallTurn, RunEvent } from "@/lib/contract"
import { simNow } from "@/lib/agent/clock"
import { scenarioFor } from "@/lib/agent/sim/scenarios"
import { db } from "@/lib/db"
import { ringCalls, ringMeta, ringRuns, ringSteps } from "@/lib/ring-schema"
import { computeSavings, DEFAULT_ESTIMATES, helsinkiDay, parseEstimates, type Savings } from "@/lib/savings"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const KEY = "savings_estimates"
const iso = (v: string) => new Date(v).toISOString()

async function savings(): Promise<Savings> {
  const now = await simNow()
  const today = helsinkiDay(now)
  // ponytail: reads every run and call, then filters by day in JS; add a started_at range if the tables grow past a demo.
  const [runs, calls, [meta]] = await Promise.all([
    db.select({ id: ringRuns.id, startedAt: ringRuns.startedAt }).from(ringRuns),
    db.select().from(ringCalls),
    db.select().from(ringMeta).where(eq(ringMeta.key, KEY)),
  ])
  const todayRuns = runs.filter((r) => helsinkiDay(iso(r.startedAt)) === today)
  const steps = todayRuns.length ? await db.select({ event: ringSteps.event }).from(ringSteps).where(inArray(ringSteps.runId, todayRuns.map((r) => r.id))) : []
  const toolResults = steps.flatMap(({ event }) => { const e = event as RunEvent; return e.type === "tool_result" && e.ok ? [e.tool] : [] })
  return computeSavings({
    now, runs: todayRuns.length, toolResults, estimates: parseEstimates(meta?.value) ?? DEFAULT_ESTIMATES,
    calls: calls.filter((c) => helsinkiDay(iso(c.startedAt)) === today).map((c) => {
      // Hold nodes carry their length in the phone tree; the transcript says which ones the call sat in.
      const nodes = scenarioFor(c.orderId, { id: c.siteId, name: "", details: {} }).ivr.nodes
      const holdSeconds = (c.transcript as CallTurn[]).reduce((s, t) => s + (t.heard === "hold" && t.nodeId ? nodes[t.nodeId]?.seconds ?? 0 : 0), 0)
      return { startedAt: iso(c.startedAt), endedAt: c.endedAt ? iso(c.endedAt) : null, holdSeconds }
    }),
  })
}

export async function GET() {
  return NextResponse.json(await savings())
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const estimates = parseEstimates(body?.estimates)
  if (!estimates) return NextResponse.json({ error: "Each estimate must be a number of minutes from 0 to 60.", code: "BAD_ESTIMATE" }, { status: 400 })
  await db.insert(ringMeta).values({ key: KEY, value: estimates }).onConflictDoUpdate({ target: ringMeta.key, set: { value: estimates } })
  return NextResponse.json(await savings())
}
