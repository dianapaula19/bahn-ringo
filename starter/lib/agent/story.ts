// Queue and order story: dataset bundles + Ringo rows → contract shapes.
import { db } from "@/lib/db"
import type { OrderStory, QueueItem, QueueResponse, StoryEntry, Triage } from "@/lib/contract"
import { messages as messagesTable } from "@/lib/schema"
import type { Bundle, MessageRow } from "@/lib/present/bundle"
import { describeEvent } from "@/lib/present/events"
import { humanize } from "@/lib/present/labels"
import { loadBoardBundles, loadOrder } from "@/lib/present/load"
import { orderFacts } from "@/lib/triage/facts"
import { rankAll, ringEligibility, triage } from "@/lib/triage/triage"
import { activeClaim, type WithClaim } from "@/lib/triage/claim"
import { rankFacts } from "@/lib/triage/facts"
import { SNAPSHOT, simNow } from "./clock"
import { datasetProposals } from "./proposals"
import { emptyRing, loadRing, ringFor, type RingOrderState } from "./store"

/** The newest thing that happened on the order, from anyone: a new one ends a person's claim on it. */
function lastActivity(b: Bundle, ring: RingOrderState): string | null {
  const times = [
    ...b.messages.map((m) => m.authoredAt), ...b.alerts.map((a) => a.triggeredAt), ...b.events.map((e) => e.recordedAt),
    ...ring.calls.map((c) => c.startedAt), ...ring.driverMessages.map((d) => d.at), ...ring.runs.map((r) => r.startedAt),
    ...ring.events.map((e) => e.at), ...ring.proposals.flatMap((p) => [p.createdAt, ...(p.review ? [p.review.reviewedAt] : [])]),
  ]
  return times.map((t) => new Date(t).toISOString()).sort().pop() ?? null
}

// The queue does not draw fact chips (the story carries them), so rows leave them out: they were most of the payload.
function item(b: Bundle, t: Triage, ring: RingOrderState, now: string): QueueItem & WithClaim {
  const v = b.items.find((i) => i.role === "PRIMARY")?.vehicle ?? b.items[0]?.vehicle
  const from = b.places.get(b.order.pickupAddressId)?.city ?? "?"
  const to = b.places.get(b.order.deliveryAddressId)?.city ?? "?"
  return { ...t, chips: [], vehicle: v ? `${v.make} ${v.model}` : "Vehicle unknown", customer: b.customer.name, route: `${from} → ${to}`, lane: b.order.lane,
    claim: t.bucket === "needs_you" ? activeClaim(ring.claims, lastActivity(b, ring), now) : null }
}

/** Every order triaged, with messages attached so driver/customer rules can read them. */
export async function triageAll(now: string): Promise<{ bundle: Bundle; ring: RingOrderState; triage: Triage }[]> {
  const [{ bundles }, msgs, ring] = await Promise.all([loadBoardBundles(), db.select().from(messagesTable), loadRing()])
  const byOrder = new Map<string, MessageRow[]>()
  for (const m of msgs) {
    const row: MessageRow = { id: m.id, orderId: m.orderId, conversationId: m.conversationId, authorType: m.authorType, body: m.body, authoredAt: m.authoredAt.toISOString(), details: m.details }
    byOrder.set(m.orderId, [...(byOrder.get(m.orderId) ?? []), row])
  }
  return bundles.map((b) => {
    const bundle = { ...b, messages: byOrder.get(b.order.id) ?? [] }
    const r = ring.get(b.order.id) ?? emptyRing()
    return { bundle, ring: r, triage: triage(bundle, r, now) }
  })
}

export async function buildQueue(): Promise<QueueResponse> {
  const now = await simNow()
  const all = await triageAll(now)
  const items = all.map(({ bundle, ring, triage: t }) => item(bundle, t, ring, now))
  const pick = (bucket: Triage["bucket"]) => rankAll(items.filter((i) => i.bucket === bucket))
  return { now, snapshotAt: SNAPSHOT, needsYou: pick("needs_you"), ring: pick("ring"), waiting: pick("waiting"), quietCount: items.filter((i) => i.bucket === "quiet").length, total: items.length }
}

export async function triageOne(orderId: string): Promise<Triage | null> {
  const loaded = await loadOrder(orderId)
  if (!loaded) return null
  return triage(loaded.bundle, await ringFor(orderId), await simNow())
}

const ACTOR_KIND: Record<string, StoryEntry["actorKind"]> = {
  customer: "customer", site_contact: "site", handoff_contact: "site", driver: "driver", operator: "operator", agent: "agent", system: "system",
}

export async function buildStory(orderId: string): Promise<(OrderStory & WithClaim) | null> {
  const loaded = await loadOrder(orderId)
  if (!loaded) return null
  const now = await simNow()
  const b = loaded.bundle
  const ring = await ringFor(orderId)
  const facts = orderFacts(b, ring, now)
  const factsBySource = (id: string) => facts.filter((f) => f.sourceId === id).map((f) => f.id)
  const t = triage(b, ring, now, facts)
  const timeline: StoryEntry[] = []
  for (const m of b.messages) {
    const actor = b.dir.resolve(m.details.author_id, m.authorType)
    timeline.push({ at: m.authoredAt, actor: actor.name, actorKind: ACTOR_KIND[actor.kind] ?? "system", text: m.body, ref: { table: "messages", id: m.id }, factIds: factsBySource(m.id), channel: humanize(String(m.details.channel ?? "")) || null, simulated: false })
  }
  for (const a of b.alerts) timeline.push({ at: a.triggeredAt, actor: "Monitoring", actorKind: "system", text: a.summary, ref: { table: "alerts", id: a.id }, factIds: factsBySource(a.id), channel: null, simulated: false })
  for (const e of b.events) {
    const h = describeEvent(e, b)
    timeline.push({ at: e.recordedAt, actor: h.actor ?? "System", actorKind: h.actor ? ACTOR_KIND[String(e.details.actor_type)] ?? "system" : "system", text: h.detail ? `${h.text} (${h.detail})` : h.text, ref: { table: "operational_events", id: e.id }, factIds: factsBySource(e.id), channel: null, simulated: false })
  }
  const siteName = (id: string) => b.sites.get(id)?.name ?? id
  for (const c of ring.calls) timeline.push({
    at: c.startedAt, actor: "Ringo", actorKind: "ring", ref: { table: "ring_calls", id: c.id }, factIds: factsBySource(c.id), channel: "Simulated call", simulated: true,
    text: `Called ${siteName(c.siteId)}: ${c.outcome ? humanize(c.outcome).toLowerCase() : "in progress"}. ${c.purpose}`,
  })
  for (const d of ring.driverMessages) timeline.push({
    at: d.at, actor: d.direction === "out" ? "Ringo" : (b.dir.driverName(d.driverId) ?? "Driver"), actorKind: d.direction === "out" ? "ring" : "driver",
    text: d.body, ref: { table: "ring_driver_messages", id: d.id }, factIds: factsBySource(d.id), channel: "Simulated driver chat", simulated: true,
  })
  for (const p of ring.proposals) {
    timeline.push({ at: p.createdAt, actor: "Ringo", actorKind: "ring", text: `Proposed: ${p.summary}`, ref: { table: "ring_proposals", id: p.id }, factIds: [], channel: null, simulated: false })
    if (p.review) timeline.push({ at: p.review.reviewedAt, actor: humanize(p.review.reviewerId), actorKind: "operator", text: `${humanize(p.review.decision)}: ${p.summary}${p.review.decisionNote ? ` (${p.review.decisionNote})` : ""}`, ref: { table: "ring_proposals", id: p.id }, factIds: [], channel: null, simulated: false })
  }
  for (const e of ring.events) timeline.push({ at: e.at, actor: e.actorType === "agent" ? "Ringo" : humanize(e.actorId), actorKind: e.actorType === "agent" ? "ring" : "operator",
    text: e.command === "recovery.choice" ? `Recorded the customer's choice: ${e.changes.choice === "tow" ? "tow" : "roadside assistance"}. “${String(e.changes.note ?? "")}”` : `${humanize(e.command)} recorded (simulated)`,
    ref: { table: "ring_events", id: e.id }, factIds: factsBySource(e.id), channel: null, simulated: e.command !== "recovery.choice" })
  for (const c of ring.claims) timeline.push({ at: c.at, actor: humanize(c.by), actorKind: "operator", text: `I'll handle it. Back in the queue at ${c.recheckAt.slice(11, 16)} UTC${c.note ? `: ${c.note}` : "."}`, ref: { table: "ring_claims", id: c.id }, factIds: [], channel: null, simulated: false })
  for (const r of ring.runs) if (r.decision && r.endedAt) timeline.push({ at: r.endedAt, actor: "Ringo", actorKind: "ring", text: r.decision.headline, ref: { table: "ring_runs", id: r.id }, factIds: r.decision.found, channel: null, simulated: false })
  timeline.sort((x, y) => x.at.localeCompare(y.at))
  const eligible = ringEligibility(b)
  const lastDecision = [...ring.runs].reverse().find((r) => r.decision && r.decision.outcome !== "failed")?.decision ?? null
  return {
    now, orderId, reference: b.order.reference, triage: t, facts: rankFacts(facts, t, b.order.status), timeline,
    proposals: [...datasetProposals(b, now), ...ring.proposals], runs: ring.runs, calls: ring.calls, driverMessages: ring.driverMessages,
    callbacks: ring.jobs, decision: lastDecision, ringEligible: eligible.ok, ringIneligibleReason: eligible.reason,
    claim: activeClaim(ring.claims, lastActivity(b, ring), now),
  }
}
