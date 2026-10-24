// Evidence ladder rules, enforced in code: the citation sanitizer (source ids
// must resolve), level caps by source type, no "verified" from Ringo, and
// refutations must cite a later source. CONTRACT §3.
import { inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import type { EvidenceLevel, Fact, SourceKind } from "@/lib/contract"
import { addresses, alerts, messages, operationalEvents, orders, relatedRecords, sites } from "@/lib/schema"
import { ringCalls, ringDriverMessages, ringEvents, ringFacts, ringJobs, ringProposals, ringRuns } from "@/lib/ring-schema"

export type SourceInfo = {
  table: string
  orderId: string | null
  at: string | null
  /** messages: author_type; ring_calls: outcome; ring_driver_messages: direction; related: status-ish */
  kind: string | null
  details: Record<string, unknown>
}

const TIME_KEYS = ["authored_at", "stated_at", "recorded_at", "observed_at", "checked_at", "opened_at", "triggered_at",
  "created_at", "submitted_at", "updated_at", "start_at", "occurred_at", "arrived_at", "reviewed_at"]
const pickTime = (d: Record<string, unknown>) => {
  for (const k of TIME_KEYS) if (typeof d[k] === "string") return new Date(d[k] as string).toISOString()
  return null
}
const isoOf = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null)

/** Resolve source ids across dataset and ring tables. Missing ids are absent from the map. */
export async function resolveSources(ids: string[]): Promise<Map<string, SourceInfo>> {
  const want = [...new Set(ids.filter(Boolean))]
  const out = new Map<string, SourceInfo>()
  if (!want.length) return out
  const [m, a, e, rr, ad, si, o, c, dm, f, p, ev, ru, j] = await Promise.all([
    db.select().from(messages).where(inArray(messages.id, want)),
    db.select().from(alerts).where(inArray(alerts.id, want)),
    db.select().from(operationalEvents).where(inArray(operationalEvents.id, want)),
    db.select().from(relatedRecords).where(inArray(relatedRecords.id, want)),
    db.select().from(addresses).where(inArray(addresses.id, want)),
    db.select().from(sites).where(inArray(sites.id, want)),
    db.select().from(orders).where(inArray(orders.id, want)),
    db.select().from(ringCalls).where(inArray(ringCalls.id, want)),
    db.select().from(ringDriverMessages).where(inArray(ringDriverMessages.id, want)),
    db.select().from(ringFacts).where(inArray(ringFacts.id, want)),
    db.select().from(ringProposals).where(inArray(ringProposals.id, want)),
    db.select().from(ringEvents).where(inArray(ringEvents.id, want)),
    db.select().from(ringRuns).where(inArray(ringRuns.id, want)),
    db.select().from(ringJobs).where(inArray(ringJobs.id, want)),
  ])
  for (const r of m) out.set(r.id, { table: "messages", orderId: r.orderId, at: isoOf(r.authoredAt), kind: r.authorType, details: { ...r.details, body: r.body } })
  for (const r of a) out.set(r.id, { table: "alerts", orderId: r.orderId, at: isoOf(r.triggeredAt), kind: r.signal, details: r.details })
  for (const r of e) out.set(r.id, { table: "operational_events", orderId: r.orderId, at: isoOf(r.recordedAt), kind: r.command, details: r.details })
  for (const r of rr) out.set(r.id, { table: r.collection, orderId: r.orderId, at: pickTime(r.details), kind: typeof r.details.status === "string" ? r.details.status : null, details: r.details })
  for (const r of ad) out.set(r.id, { table: "addresses", orderId: r.orderId, at: null, kind: null, details: r.details })
  for (const r of si) out.set(r.id, { table: "sites", orderId: null, at: null, kind: r.kind, details: r.details })
  for (const r of o) out.set(r.id, { table: "orders", orderId: r.id, at: isoOf(r.updatedAt), kind: r.status, details: r.details })
  for (const r of c) out.set(r.id, { table: "ring_calls", orderId: r.orderId, at: isoOf(r.endedAt ?? r.startedAt), kind: r.outcome, details: { siteSpoke: (r.transcript as { speaker: string }[]).some((t) => t.speaker === "site") } })
  for (const r of dm) out.set(r.id, { table: "ring_driver_messages", orderId: r.orderId, at: isoOf(r.at), kind: r.direction, details: {} })
  for (const r of f) out.set(r.id, { table: "ring_facts", orderId: r.orderId, at: isoOf(r.at), kind: r.level, details: {} })
  for (const r of p) out.set(r.id, { table: "ring_proposals", orderId: r.orderId, at: isoOf(r.createdAt), kind: r.status, details: {} })
  for (const r of ev) out.set(r.id, { table: "ring_events", orderId: r.orderId, at: isoOf(r.at), kind: r.command, details: {} })
  for (const r of ru) out.set(r.id, { table: "ring_runs", orderId: r.orderId, at: isoOf(r.startedAt), kind: r.status, details: {} })
  for (const r of j) out.set(r.id, { table: "ring_jobs", orderId: r.orderId, at: isoOf(r.dueAt), kind: r.status, details: {} })
  return out
}

export const LEVEL_RANK: Record<EvidenceLevel, number> = { claimed: 0, quoted: 1, reserved: 2, observed: 3, verified: 4, stale: -1, refuted: -1 }

/** Which source kinds may cite which tables. */
const KIND_TABLES: Record<SourceKind, string[]> = {
  message: ["messages", "support_inbox_messages"], order_note: ["order_notes"], endpoint_detail: ["order_endpoint_details"],
  endpoint_claim: ["endpoint_claims"], site_profile: ["sites", "addresses"], alert: ["alerts"], incident: ["incidents"],
  work_item: ["work_items"], time_window: ["time_windows"], work_assignment: ["work_assignments"], travel_option: ["travel_options"],
  travel_reservation: ["travel_reservations"], tracking: ["tracking_observations"], ferry_gate: ["ferry_terminal_events"],
  proof: ["proofs"], document: ["documents"], event: ["operational_events"], agent_proposal: ["agent_proposals", "ring_proposals"],
  ring_call: ["ring_calls"], ring_driver_message: ["ring_driver_messages"], ring_event: ["ring_events"],
}

/** Highest level a source of this kind can support (CONTRACT §3 table). */
export function levelCap(kind: SourceKind, info: SourceInfo): EvidenceLevel {
  const d = info.details
  switch (kind) {
    case "message": return info.kind === "site_contact" ? "quoted" : "claimed"
    case "endpoint_detail": return d.stated_by === "SITE_CONTACT" ? "quoted" : "claimed"
    case "ring_call": return info.details.siteSpoke === true ? "quoted" : "claimed"
    case "travel_option": return "quoted"
    case "time_window": return d.is_selected === true ? "reserved" : "claimed"
    case "work_assignment": case "travel_reservation": case "ring_event": return "reserved"
    case "tracking": case "proof": case "document": case "event": case "ferry_gate": return "observed"
    default: return "claimed"
  }
}

export type FactInput = {
  subject: string; claim: string; level: EvidenceLevel; sourceKind: SourceKind; sourceId: string
  at?: string; by: string; supersedesFactId?: string | null
  /** With supersedesFactId: "refutes" marks the old fact refuted, "replaces" marks it stale. */
  effect?: "refutes" | "replaces" | null
  note?: string | null
}

/**
 * Check a fact Ringo wants to record. Returns the fact to store or a plain error
 * the model reads. `known` are the order's current facts (dataset + ring).
 */
export function checkFact(orderId: string, input: FactInput, info: SourceInfo | undefined, known: Fact[]):
  { fact: Omit<Fact, "id">; old: { id: string; level: "refuted" | "stale"; origin: Fact["origin"] } | null } | { error: string } {
  if (!info) return { error: `Source ${input.sourceId} does not exist. Cite a real row id from read_order or read_messages.` }
  if (info.orderId && info.orderId !== orderId) return { error: `Source ${input.sourceId} belongs to another order.` }
  if (!KIND_TABLES[input.sourceKind]?.includes(info.table)) return { error: `Source ${input.sourceId} is a ${info.table} row, not a ${input.sourceKind}.` }
  if (input.level === "verified") return { error: "Ringo may never record a verified fact. Only a person's check or an approved proof is verified." }
  const old = input.supersedesFactId ? known.find((f) => f.id === input.supersedesFactId) : null
  if (input.supersedesFactId && !old) return { error: `Fact ${input.supersedesFactId} is not a fact on this order.` }
  const at = info.at ?? input.at ?? null
  if (!at) return { error: "The source has no time; pass `at`." }
  if (input.level === "refuted" || input.level === "stale") {
    return { error: `Record what the new source says at its own level, and pass supersedesFactId with effect "refutes" or "replaces" to overturn the old fact.` }
  }
  const cap = levelCap(input.sourceKind, info)
  if (LEVEL_RANK[input.level] > LEVEL_RANK[cap]) return { error: `A ${input.sourceKind} source supports at most "${cap}", not "${input.level}".` }
  if (old && old.supersededByFactId) return { error: `Fact ${old.id} was already overturned.` }
  const effect = input.effect ?? "replaces"
  if (old && effect === "refutes" && Date.parse(at) <= Date.parse(old.at)) return { error: `A refutation must cite a source later than ${old.at}.` }
  return {
    old: old ? { id: old.id, level: effect === "refutes" ? "refuted" : "stale", origin: old.origin } : null,
    fact: {
      orderId, subject: input.subject, claim: input.claim, level: input.level, sourceKind: input.sourceKind, sourceId: input.sourceId,
      at, by: input.by, origin: "ring", supersededByFactId: null, note: input.note ?? null,
    },
  }
}

/** Display level at `now`: quotes age out after 2 h, tracking after 60 min; superseded facts read stale. */
export function effectiveLevel(f: Fact, now: string): EvidenceLevel {
  if (f.level === "refuted" || f.level === "stale") return f.level
  if (f.supersededByFactId) return "stale"
  const age = (Date.parse(now) - Date.parse(f.at)) / 60000
  if (f.level === "quoted" && f.sourceKind !== "endpoint_detail" && age > 120) return "stale"
  if (f.sourceKind === "tracking" && age > 60) return "stale"
  return f.level
}
