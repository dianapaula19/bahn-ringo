// Ringo learns from your edits: corrections in, suggestions out, accepted rules into the gate.
// A suggestion never applies itself. Only "accept" puts a rule in the gate; "dismiss" closes the pattern for good.
import { asc, eq, inArray, isNotNull } from "drizzle-orm"
import { db } from "@/lib/db"
import type { Proposal, Review } from "@/lib/contract"
import type { Bundle } from "@/lib/present/bundle"
import { ringCorrections, ringLearnedRules } from "@/lib/ring-schema"
import { newId, simNow } from "../clock"
import type { ExtraRule } from "../gate"
import { derive, patternKey, reasonClass, situationOf, violation, type CorrectionLite } from "./derive"
import type { Citation, LearnedDecision, LearnedDecisionResponse, LearnedRule, LearnedSpec, LearnedStatus, LearnedVersion } from "./types"

type CorrRow = typeof ringCorrections.$inferSelect
type RuleRow = typeof ringLearnedRules.$inferSelect
const iso = (v: string) => new Date(v).toISOString()

const lite = (c: CorrRow): CorrectionLite => ({
  id: c.id, proposalId: c.proposalId, actionType: c.actionType as CorrectionLite["actionType"], kind: c.kind as "edit" | "reject",
  field: c.field, before: c.before, after: c.after, reasonClass: c.reasonClass, situation: c.situation as string[],
})

const cite = (c: CorrRow): Citation => ({
  correctionId: c.id, proposalId: c.proposalId, orderId: c.orderId, orderRef: c.orderRef, decision: c.kind === "edit" ? "EDITED" : "REJECTED",
  field: c.field, before: c.before, after: c.after, note: c.note, reviewerId: c.reviewerId, at: iso(c.at),
})

function toRule(r: RuleRow, corr: Map<string, CorrRow>): LearnedRule {
  const cited = (r.correctionIds as string[]).map((id) => corr.get(id)).filter((c): c is CorrRow => !!c)
  return {
    id: r.id, ruleId: r.ruleId, status: r.status as LearnedStatus, version: r.version, actionType: r.actionType as LearnedRule["actionType"],
    spec: r.spec as LearnedSpec, title: r.title, text: r.text, ask: r.ask, learnedFrom: [...new Set(cited.map((c) => c.proposalId))],
    citations: cited.map(cite), history: r.history as LearnedVersion[], createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
  }
}

async function withCitations(rules: RuleRow[]): Promise<LearnedRule[]> {
  const ids = [...new Set(rules.flatMap((r) => r.correctionIds as string[]))]
  const corr = ids.length ? await db.select().from(ringCorrections).where(inArray(ringCorrections.id, ids)) : []
  const map = new Map(corr.map((c) => [c.id, c]))
  return rules.map((r) => toRule(r, map))
}

/** Called from review(): store what the person changed, then look for a pattern. Returns a fresh suggestion, if any. */
export async function recordCorrections(p: Proposal, rv: Review, b: Bundle): Promise<LearnedRule | null> {
  if (rv.decision === "APPROVED" || !p.actionType) return null
  const situation = situationOf(b)
  const common = { proposalId: p.id, orderId: p.orderId, orderRef: b.order.reference, actionType: p.actionType, note: rv.decisionNote ?? "", situation, reviewerId: rv.reviewerId, at: rv.reviewedAt }
  const rowsIn: CorrRow[] = []
  if (rv.decision === "REJECTED") {
    const cls = reasonClass(rv.decisionNote ?? "")
    rowsIn.push({ ...common, id: newId("corr"), kind: "reject", field: null, before: null, after: null, reasonClass: cls, patternKey: patternKey({ kind: "reject", actionType: p.actionType, field: null, reasonClass: cls }) })
  } else {
    const before = p.proposedPayload, after = rv.finalPayload
    for (const field of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
      if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue
      rowsIn.push({ ...common, id: newId("corr"), kind: "edit", field, before: before[field] ?? null, after: after[field] ?? null, reasonClass: null, patternKey: patternKey({ kind: "edit", actionType: p.actionType, field, reasonClass: null }) })
    }
  }
  if (!rowsIn.length) return null
  await db.insert(ringCorrections).values(rowsIn)
  let suggestion: LearnedRule | null = null
  for (const key of new Set(rowsIn.map((r) => r.patternKey))) suggestion = (await refreshPattern(key, rv.reviewedAt)) ?? suggestion
  return suggestion
}

/** Re-derive one pattern. Decided patterns (accepted, off, dismissed) are never re-asked. */
async function refreshPattern(key: string, now: string): Promise<LearnedRule | null> {
  const [existing] = await db.select().from(ringLearnedRules).where(eq(ringLearnedRules.patternKey, key))
  if (existing && existing.status !== "suggested") return null
  const group = await db.select().from(ringCorrections).where(eq(ringCorrections.patternKey, key)).orderBy(asc(ringCorrections.at))
  const draft = derive(group.map(lite))
  if (!draft) {
    // The latest correction broke the pattern: no common, checkable change any more, so no question.
    if (existing) await db.delete(ringLearnedRules).where(eq(ringLearnedRules.id, existing.id))
    return null
  }
  const row: RuleRow = {
    id: existing?.id ?? newId("lrule"), patternKey: key, ruleId: null, status: "suggested", version: 0, actionType: draft.spec.actionType,
    spec: draft.spec, title: draft.title, text: draft.text, ask: draft.ask, correctionIds: group.map((c) => c.id), history: [],
    createdAt: existing?.createdAt ?? now, updatedAt: now, updatedBy: "ring",
  }
  const { id: _id, createdAt: _created, ...update } = row
  await db.insert(ringLearnedRules).values(row).onConflictDoUpdate({ target: ringLearnedRules.patternKey, set: update })
  return (await withCitations([row]))[0]
}

export async function listLearned(): Promise<LearnedRule[]> {
  return withCitations(await db.select().from(ringLearnedRules).orderBy(asc(ringLearnedRules.createdAt)))
}

/** Active learned rules as gate rules for one order (scoped by what is open on it). */
export async function learnedGateRules(b: Bundle): Promise<ExtraRule[]> {
  const active = await withCitations(await db.select().from(ringLearnedRules).where(eq(ringLearnedRules.status, "active")))
  const situation = situationOf(b)
  return active.map((r) => ({ id: r.ruleId!, effect: "block" as const, learnedFrom: r.learnedFrom, test: (p) => violation(r.spec, p, situation) }))
}

export async function decideLearned(id: string, req: LearnedDecision): Promise<{ status: number; body: LearnedDecisionResponse }> {
  const now = await simNow()
  const [row] = await db.select().from(ringLearnedRules).where(eq(ringLearnedRules.id, id))
  if (!row) return { status: 404, body: { error: "No such rule.", code: "NOT_FOUND" } }
  const text = req.text?.trim()
  if (req.action === "edit" && !text) return { status: 400, body: { error: "Write the new wording.", code: "TEXT_REQUIRED" } }
  const from: Record<LearnedDecision["action"], LearnedStatus[]> = { accept: ["suggested"], dismiss: ["suggested"], off: ["active"], on: ["off"], edit: ["active", "off"] }
  if (!from[req.action].includes(row.status as LearnedStatus)) return { status: 409, body: { error: `This rule is ${row.status}; it can't be ${req.action === "on" ? "switched on" : req.action === "off" ? "switched off" : `${req.action}ed`}.`, code: "BAD_STATE" } }
  const set: Partial<RuleRow> = { updatedAt: now, updatedBy: req.operatorId }
  if (req.action === "accept") {
    const taken = await db.select({ ruleId: ringLearnedRules.ruleId }).from(ringLearnedRules).where(isNotNull(ringLearnedRules.ruleId))
    const next = Math.max(0, ...taken.map((t) => Number(t.ruleId!.slice(4)))) + 1
    Object.assign(set, { status: "active", ruleId: `CL-L${String(next).padStart(2, "0")}`, version: 1, text: text || row.text })
  } else if (req.action === "dismiss") set.status = "dismissed"
  else if (req.action === "off") set.status = "off"
  else if (req.action === "on") set.status = "active"
  else Object.assign(set, { text, version: row.version + 1 })
  const entry: LearnedVersion = { version: set.version ?? row.version, status: (set.status ?? row.status) as LearnedStatus, text: set.text ?? row.text, at: now, by: req.operatorId }
  set.history = [...(row.history as LearnedVersion[]), entry]
  await db.update(ringLearnedRules).set(set).where(eq(ringLearnedRules.id, id))
  const [updated] = await db.select().from(ringLearnedRules).where(eq(ringLearnedRules.id, id))
  return { status: 200, body: { now, rule: (await withCitations([updated]))[0] } }
}

