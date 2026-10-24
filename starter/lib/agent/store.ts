// Ring rows → contract shapes, plus one loader for everything Ring knows about
// one order (or all orders). Pure mapping, no business rules.
import { asc, eq } from "drizzle-orm"
import { db } from "@/lib/db"
import type {
  CallRecord, CallbackJob, DriverMessage, Fact, Proposal, RunSummary, SourceRef,
} from "@/lib/contract"
import { ringCalls, ringDriverMessages, ringEvents, ringFacts, ringJobs, ringMeta, ringProposals, ringRuns } from "@/lib/ring-schema"

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null)

export const toRun = (r: typeof ringRuns.$inferSelect): RunSummary => ({
  id: r.id, orderId: r.orderId, trigger: r.trigger as RunSummary["trigger"], status: r.status as RunSummary["status"],
  startedAt: iso(r.startedAt)!, endedAt: iso(r.endedAt), model: r.model, decision: (r.decision as RunSummary["decision"]) ?? null,
  error: r.error, operatorMessage: r.operatorMessage,
})

export const toCall = (r: typeof ringCalls.$inferSelect): CallRecord => ({
  id: r.id, runId: r.runId, orderId: r.orderId, siteId: r.siteId, number: r.number, purpose: r.purpose,
  status: r.status as CallRecord["status"], outcome: (r.outcome as CallRecord["outcome"]) ?? null,
  ivrPath: r.ivrPath as string[], transcript: r.transcript as CallRecord["transcript"],
  startedAt: iso(r.startedAt)!, endedAt: iso(r.endedAt),
  reconciledFrom: (r.reconciledFrom as CallRecord["reconciledFrom"]) ?? null, simulated: true,
})

export const toDriverMessage = (r: typeof ringDriverMessages.$inferSelect): DriverMessage => ({
  id: r.id, runId: r.runId, orderId: r.orderId, driverId: r.driverId, direction: r.direction as DriverMessage["direction"],
  intent: r.intent as DriverMessage["intent"], body: r.body, at: iso(r.at)!, proposalId: r.proposalId, simulated: true,
})

export const toFact = (r: typeof ringFacts.$inferSelect): Fact => ({
  id: r.id, orderId: r.orderId, subject: r.subject, claim: r.claim, level: r.level as Fact["level"],
  sourceKind: r.sourceKind as Fact["sourceKind"], sourceId: r.sourceId, at: iso(r.at)!, by: r.by, origin: "ring",
  supersededByFactId: r.supersededByFactId, note: r.note,
})

export const toProposal = (r: typeof ringProposals.$inferSelect): Proposal => ({
  id: r.id, origin: "ring", orderId: r.orderId, proposedByAgentId: "ring", command: r.command,
  actionType: r.actionType as Proposal["actionType"], targetType: r.targetType, targetId: r.targetId, alertId: r.alertId,
  proposedPayload: r.proposedPayload as Record<string, unknown>, rationale: r.rationale, summary: r.summary,
  evidenceRefs: r.evidenceRefs as SourceRef[], dependency: r.dependency as Proposal["dependency"],
  status: r.status as Proposal["status"], review: (r.review as Proposal["review"]) ?? null,
  execution: (r.execution as Proposal["execution"]) ?? null, supersededByProposalId: r.supersededByProposalId,
  createdAt: iso(r.createdAt)!, onApprove: r.onApprove, onReject: r.onReject, gate: (r.gate as Proposal["gate"]) ?? null,
  trustMode: (r.trustMode as Proposal["trustMode"]) ?? null, runId: r.runId,
})

export const toJob = (r: typeof ringJobs.$inferSelect): CallbackJob => ({
  id: r.id, orderId: r.orderId, dueAt: iso(r.dueAt)!, reason: r.reason, status: r.status as CallbackJob["status"],
  createdByRunId: r.createdByRunId, firedRunId: r.firedRunId,
})

export type RingEvent = {
  id: string; orderId: string; at: string; command: string; actorType: string; actorId: string
  proposalId: string | null; changes: Record<string, unknown>; sourceRefs: SourceRef[]
}
const toEvent = (r: typeof ringEvents.$inferSelect): RingEvent => ({
  ...r, at: iso(r.at)!, changes: r.changes as Record<string, unknown>, sourceRefs: r.sourceRefs as SourceRef[],
})

/** Everything Ring has recorded about one order. All lists oldest first. */
export type RingOrderState = {
  runs: RunSummary[]; calls: CallRecord[]; driverMessages: DriverMessage[]; facts: Fact[]
  proposals: Proposal[]; events: RingEvent[]; jobs: CallbackJob[]
  /** Dataset fact id → the ring fact id that superseded it. */
  datasetSupersede: Record<string, { factId: string; level: "refuted" | "stale" }>
}

export const emptyRing = (): RingOrderState => ({
  runs: [], calls: [], driverMessages: [], facts: [], proposals: [], events: [], jobs: [], datasetSupersede: {},
})

export async function loadRing(orderId?: string): Promise<Map<string, RingOrderState>> {
  const where = <T extends { orderId: unknown }>(t: T) => (orderId ? eq(t.orderId as never, orderId) : undefined)
  const [runs, calls, dms, facts, props, events, jobs, meta] = await Promise.all([
    db.select().from(ringRuns).where(where(ringRuns)).orderBy(asc(ringRuns.startedAt)),
    db.select().from(ringCalls).where(where(ringCalls)).orderBy(asc(ringCalls.startedAt)),
    db.select().from(ringDriverMessages).where(where(ringDriverMessages)).orderBy(asc(ringDriverMessages.at)),
    db.select().from(ringFacts).where(where(ringFacts)).orderBy(asc(ringFacts.at)),
    db.select().from(ringProposals).where(where(ringProposals)).orderBy(asc(ringProposals.createdAt)),
    db.select().from(ringEvents).where(where(ringEvents)).orderBy(asc(ringEvents.at)),
    db.select().from(ringJobs).where(where(ringJobs)).orderBy(asc(ringJobs.dueAt)),
    db.select().from(ringMeta),
  ])
  const out = new Map<string, RingOrderState>()
  const get = (id: string) => { let s = out.get(id); if (!s) out.set(id, (s = emptyRing())); return s }
  for (const r of runs) get(r.orderId).runs.push(toRun(r))
  for (const r of calls) get(r.orderId).calls.push(toCall(r))
  for (const r of dms) get(r.orderId).driverMessages.push(toDriverMessage(r))
  for (const r of facts) get(r.orderId).facts.push(toFact(r))
  for (const r of props) get(r.orderId).proposals.push(toProposal(r))
  for (const r of events) get(r.orderId).events.push(toEvent(r))
  for (const r of jobs) get(r.orderId).jobs.push(toJob(r))
  for (const m of meta) {
    if (!m.key.startsWith("supersede:")) continue
    const v = m.value as { orderId: string; factId: string; level: "refuted" | "stale" }
    if (!orderId || v.orderId === orderId) get(v.orderId).datasetSupersede[m.key.slice("supersede:".length)] = { factId: v.factId, level: v.level }
  }
  return out
}

export async function ringFor(orderId: string): Promise<RingOrderState> {
  return (await loadRing(orderId)).get(orderId) ?? emptyRing()
}
