// Proposals: gate first, trust ledger decides, recheck before write on approval.
import { and, desc, eq, isNull } from "drizzle-orm"
import { db } from "@/lib/db"
import type {
  ActionType, Desk, Execution, Proposal, ReviewRequest, ReviewResponse, SourceRef,
} from "@/lib/contract"
import { rows, type Bundle } from "@/lib/present/bundle"
import { loadOrder } from "@/lib/present/load"
import { ringDriverMessages, ringEvents, ringFacts, ringMeta, ringProposals } from "@/lib/ring-schema"
import { datasetFacts } from "@/lib/triage/facts"
import type { GateContext } from "./caselaw"
import { newId, simNow } from "./clock"
import { runGate } from "./gate"
import { learnedGateRules, recordCorrections } from "./learn/store"
import type { LearnedRule } from "./learn/types"
import { toProposal } from "./store"
import { trustMode, TRUST_DEFAULTS } from "./trust"

export function gateContext(b: Bundle): GateContext {
  return {
    travelOptionCheckedAt: Object.fromEntries(rows(b, "travel_options").map((t) => [t.id, String(t.details.checked_at)])),
    verifiedIds: new Set([
      ...rows(b, "ferry_terminal_events").map((r) => r.id),
      ...rows(b, "proofs").filter((r) => r.details.status === "APPROVED").map((r) => r.id),
      ...rows(b, "documents").filter((r) => r.details.status === "VERIFIED").map((r) => r.id),
    ]),
  }
}

/** The newest dataset or ring event on the order: the basis a proposal depends on. */
export async function latestEventId(b: Bundle, skipProposalIds: Set<string> = new Set()): Promise<string> {
  const ring = (await db.select().from(ringEvents).where(eq(ringEvents.orderId, b.order.id)).orderBy(desc(ringEvents.at)))
    .find((e) => !e.proposalId || !skipProposalIds.has(e.proposalId))
  const ds = [...b.events].sort((x, y) => y.recordedAt.localeCompare(x.recordedAt))[0]
  if (ring && (!ds || new Date(ring.at).toISOString() >= ds.recordedAt)) return ring.id
  return ds?.id ?? b.order.id
}

/** Dataset agent_proposals as read-only Proposals, with the gate's opinion. */
export function datasetProposals(b: Bundle, now: string): Proposal[] {
  const ctx = gateContext(b)
  return rows(b, "agent_proposals").map(({ id, details: d }) => {
    const dep = d.dependency as Record<string, string>
    const review = d.review as Record<string, unknown> | null
    const exec = d.execution as Record<string, unknown> | null
    const payload = d.proposed_payload as Record<string, unknown>
    return {
      id, origin: "dataset", orderId: b.order.id, proposedByAgentId: String(d.proposed_by_agent_id), command: String(d.command), actionType: null,
      targetType: String(d.target_type), targetId: String(d.target_id), alertId: (d.alert_id as string) ?? null, proposedPayload: payload,
      rationale: String(d.rationale), summary: String(d.summary), evidenceRefs: d.evidence_refs as SourceRef[],
      dependency: { basisEventId: dep.basis_event_id, checkedAt: dep.checked_at, executionPolicy: "RECHECK_CURRENT_STATE_BEFORE_WRITE" },
      status: d.status as Proposal["status"],
      review: review ? { decision: review.decision as "APPROVED", decisionNote: (review.decision_note as string) ?? null, finalPayload: review.final_payload as Record<string, unknown>, reviewerId: review.reviewer_id as Desk, reviewedAt: String(review.reviewed_at) } : null,
      execution: exec ? { attemptedAt: String(exec.attempted_at), status: exec.status as Execution["status"], error: (exec.error as string) ?? null, effectEventIds: (exec.effect_event_ids as string[]) ?? [] } : null,
      supersededByProposalId: null, createdAt: String(d.created_at), onApprove: null, onReject: null,
      gate: runGate({ command: String(d.command), actionType: null, payload, summary: String(d.summary), evidenceRefs: d.evidence_refs as SourceRef[], createdAt: String(d.created_at) }, ctx, now),
      trustMode: null, runId: null,
    }
  })
}

export type ProposeInput = {
  command: string; actionType: ActionType; targetType: string; targetId: string; alertId?: string | null
  payload: Record<string, unknown>; rationale: string; summary: string; evidenceRefs: SourceRef[]; onApprove: string; onReject: string
}

export type ProposeResult = { proposal: Proposal; execution: Execution | null } | { blocked: Proposal["gate"]; reason: string }

export async function propose(b: Bundle, runId: string | null, input: ProposeInput): Promise<ProposeResult> {
  const now = await simNow()
  if (!TRUST_DEFAULTS[input.actionType]) return { blocked: null, reason: `Unknown action type ${input.actionType}.` }
  const gate = runGate({ command: input.command, actionType: input.actionType, payload: input.payload, summary: input.summary, evidenceRefs: input.evidenceRefs, createdAt: now }, gateContext(b), now, undefined, await learnedGateRules(b))
  if (!gate.passed) return { blocked: gate, reason: "The Reviewer gate blocked it." }
  const mode = await trustMode(input.actionType)
  if (mode === "never") return { blocked: gate, reason: `${input.actionType} is never allowed for Ringo (${TRUST_DEFAULTS[input.actionType].lockedReason}).` }
  const row = {
    id: newId("prop"), orderId: b.order.id, runId, command: input.command, actionType: input.actionType, targetType: input.targetType,
    targetId: input.targetId, alertId: input.alertId ?? null, proposedPayload: input.payload, rationale: input.rationale, summary: input.summary,
    evidenceRefs: input.evidenceRefs, dependency: { basisEventId: await latestEventId(b), checkedAt: now, executionPolicy: "RECHECK_CURRENT_STATE_BEFORE_WRITE" },
    status: "PENDING_REVIEW", review: null, execution: null, supersededByProposalId: null, onApprove: input.onApprove, onReject: input.onReject,
    gate, trustMode: mode, createdAt: now,
  }
  await db.insert(ringProposals).values(row)
  if (mode === "auto") {
    const execution = await execute(b, toProposal(row), input.payload, "ring")
    return { proposal: toProposal((await db.select().from(ringProposals).where(eq(ringProposals.id, row.id)))[0]), execution }
  }
  return { proposal: toProposal(row), execution: null }
}

/** Recheck the basis, then commit the simulated change as ring_events. */
async function execute(b: Bundle, p: Proposal, payload: Record<string, unknown>, actor: Desk | "ring"): Promise<Execution> {
  const now = await simNow()
  // Sibling proposals from the same run that change a different kind of thing were written on the same read,
  // so approving one must not make the other stale. Anything else newer than the basis does.
  const siblings = p.runId ? new Set((await db.select({ id: ringProposals.id, actionType: ringProposals.actionType }).from(ringProposals).where(eq(ringProposals.runId, p.runId)))
    .filter((r) => r.id !== p.id && r.actionType !== p.actionType).map((r) => r.id)) : new Set<string>()
  const latest = await latestEventId(b, siblings)
  if (latest !== p.dependency.basisEventId) {
    const execution: Execution = { attemptedAt: now, status: "STALE", error: `The order changed since Ringo read it (newer event ${latest}). Nothing was changed; Ringo must re-read.`, effectEventIds: [] }
    await db.update(ringProposals).set({ status: "APPROVED_AWAITING_EXECUTION", execution }).where(eq(ringProposals.id, p.id))
    return execution
  }
  const eventId = newId("revt")
  const changes: Record<string, unknown> = { ...payload, simulated: true }
  if (p.actionType === "customer.message") changes.sent_by = `${actor} (simulated)`
  await db.insert(ringEvents).values({
    id: eventId, orderId: p.orderId, at: now, command: p.command, actorType: actor === "ring" ? "agent" : "operator", actorId: actor,
    proposalId: p.id, changes, sourceRefs: p.evidenceRefs,
  })
  if (p.actionType === "driver.instruct") {
    const driverId = rows(b, "work_assignments").find((a) => a.details.status !== "CANCELLED")?.details.driver_id
    if (typeof driverId === "string") await db.insert(ringDriverMessages).values({
      id: newId("dm"), runId: p.runId, orderId: p.orderId, driverId, direction: "out", intent: "instruction",
      body: String(payload.message ?? payload.body ?? p.summary), proposalId: p.id, at: now,
    })
  }
  // An approved record change becomes a fact citing the effect event; older facts on the subject go stale.
  const subject = p.actionType === "endpoint.record_contact" ? "pickup.contact" : p.actionType === "endpoint.record_access" ? "pickup.access_route" : p.actionType === "address.update" ? "pickup.address" : null
  if (subject) {
    const factId = newId("fact")
    const contact = [payload.contact_name, payload.contact_role && `(${payload.contact_role})`, payload.contact_handle].filter(Boolean).join(" ")
    const address = [payload.address_line1, payload.city].filter(Boolean).join(", ")
    const claim = String(payload.access_instruction ?? (contact ? `Pickup contact: ${contact}.` : address ? `Pickup address: ${address}.` : p.summary))
    await db.update(ringFacts).set({ supersededByFactId: factId })
      .where(and(eq(ringFacts.orderId, p.orderId), eq(ringFacts.subject, subject), isNull(ringFacts.supersededByFactId)))
    for (const f of datasetFacts(b).filter((f) => f.subject === subject))
      await db.insert(ringMeta).values({ key: `supersede:${f.id}`, value: { orderId: p.orderId, factId, level: "stale" } }).onConflictDoNothing()
    await db.insert(ringFacts).values({ id: factId, orderId: p.orderId, runId: p.runId, subject, claim, level: "quoted", sourceKind: "ring_event", sourceId: eventId, by: `Approved by ${actor}`, at: now, supersededByFactId: null, note: "Recorded after approval (simulated)" })
  }
  const execution: Execution = { attemptedAt: now, status: "SUCCEEDED", error: null, effectEventIds: [eventId] }
  await db.update(ringProposals).set({ status: "EXECUTED", execution }).where(eq(ringProposals.id, p.id))
  return execution
}

type Reviewed = Omit<Extract<ReviewResponse, { proposal: Proposal }>, "triage"> & { suggestion: LearnedRule | null }

export async function review(id: string, req: ReviewRequest): Promise<{ status: number; body: Extract<ReviewResponse, { error: string }> | Reviewed }> {
  const now = await simNow()
  const [row] = await db.select().from(ringProposals).where(eq(ringProposals.id, id))
  if (!row) return { status: id.startsWith("agent-") ? 409 : 404, body: id.startsWith("agent-") ? { error: "Recorded dataset proposals are read-only.", code: "READ_ONLY" } : { error: "Proposal not found.", code: "NOT_FOUND" } }
  const p = toProposal(row)
  if (p.status !== "PENDING_REVIEW") return { status: 409, body: { error: `Proposal is ${p.status}.`, code: "NOT_PENDING" } }
  if (req.decision !== "APPROVED" && !req.note?.trim()) return { status: 400, body: { error: "A note is required to edit or reject.", code: "NOTE_REQUIRED" } }
  if (req.decision === "EDITED" && !req.finalPayload) return { status: 400, body: { error: "An edit needs the final payload.", code: "PAYLOAD_REQUIRED" } }
  const loaded = await loadOrder(p.orderId)
  if (!loaded) return { status: 404, body: { error: "Order not found.", code: "NOT_FOUND" } }
  const finalPayload = req.decision === "EDITED" ? req.finalPayload! : p.proposedPayload
  // A person's edit is checked against the case law only. Learned rules are this desk's own habits; a different edit is new teaching, not a breach.
  if (req.decision === "EDITED") {
    const gate = runGate({ command: p.command, actionType: p.actionType, payload: finalPayload, summary: p.summary, evidenceRefs: p.evidenceRefs, createdAt: now }, gateContext(loaded.bundle), now)
    if (!gate.passed) return { status: 409, body: { error: gate.findings.filter((f) => f.effect === "block").map((f) => `${f.ruleId}: ${f.message}`).join(" "), code: "GATE_BLOCKED" } }
  }
  const reviewRow = { decision: req.decision, decisionNote: req.note ?? null, finalPayload, reviewerId: req.reviewerId, reviewedAt: now }
  if (req.decision === "REJECTED") {
    await db.update(ringProposals).set({ status: "REJECTED", review: reviewRow }).where(eq(ringProposals.id, id))
    const suggestion = await recordCorrections(p, reviewRow, loaded.bundle)
    const proposal = toProposal((await db.select().from(ringProposals).where(eq(ringProposals.id, id)))[0])
    return { status: 200, body: { proposal, execution: null, next: p.onReject ?? "Nothing changes. Ringo notes the reason.", suggestion } }
  }
  await db.update(ringProposals).set({ status: "APPROVED_AWAITING_EXECUTION", review: reviewRow }).where(eq(ringProposals.id, id))
  const execution = await execute(loaded.bundle, { ...p, review: reviewRow }, finalPayload, req.reviewerId)
  const suggestion = await recordCorrections(p, reviewRow, loaded.bundle)
  const proposal = toProposal((await db.select().from(ringProposals).where(eq(ringProposals.id, id)))[0])
  const next = execution.status === "STALE" ? "The order changed after Ringo read it, so nothing was changed. Run Ringo again to re-read." : (p.onApprove ?? "Done.")
  return { status: 200, body: { proposal, execution, next, suggestion } }
}
