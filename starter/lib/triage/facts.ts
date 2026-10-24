// Dataset facts: derived from structured rows only (CONTRACT §3). Facts read
// from message text come only from Ringo's record_fact.
import type { EvidenceLevel, Fact, Triage } from "@/lib/contract"
import { effectiveLevel } from "@/lib/agent/facts"
import type { RingOrderState } from "@/lib/agent/store"
import { rows, str, type Bundle } from "@/lib/present/bundle"
import { label, labelIn } from "@/lib/present/labels"
import { fmtWindow } from "@/lib/present/time"
import { rankByDecision } from "./relevance"

const STATED_BY: Record<string, string> = {
  MANAGED_SITE_PROFILE: "Site profile", SITE_CONTACT: "Site contact", CUSTOMER_ORDER_INPUT: "Customer order input",
}
const iso = (v: unknown) => (typeof v === "string" ? new Date(v).toISOString() : null)
const PRE_PICKUP = ["NEW", "WAITING_FOR_PICKUP"]

/** The record's own status word ("Contact confirmed") under a fact, unless it claims more than the fact's level:
 *  a "confirmed" line under a claimed or quoted fact reads as a contradiction, so it is left out. */
function statusNote(what: string, status: unknown, level: EvidenceLevel): string | null {
  const st = String(status ?? "").toLowerCase().replace(/_/g, " ")
  if (!st) return null
  if (/\b(confirmed|verified)\b/.test(st) && !/\bun/.test(st) && level !== "observed" && level !== "verified") return null
  return `${what} ${st}`
}

export function datasetFacts(bundle: Bundle, now?: string): Fact[] {
  const out: Fact[] = []
  const add = (sourceId: string, subject: string, claim: string, level: EvidenceLevel, sourceKind: Fact["sourceKind"], at: string | null, by: string, note: string | null = null) => {
    if (!at) return
    out.push({ id: `ds:${sourceId}:${subject}`, orderId: bundle.order.id, subject, claim, level, sourceKind, sourceId, at, by, origin: "dataset", supersededByFactId: null, note })
  }
  for (const ep of rows(bundle, "order_endpoint_details")) {
    const d = ep.details
    const side = d.boundary === "PICKUP" ? "pickup" : "delivery"
    const by = STATED_BY[String(d.stated_by)] ?? "Order record"
    const level: EvidenceLevel = d.stated_by === "SITE_CONTACT" ? "quoted" : "claimed"
    const at = iso(d.stated_at)
    const contact = str(d.contact_name)
      ? `${side === "pickup" ? "Pickup" : "Delivery"} contact is ${d.contact_name} (${d.contact_role ?? "contact"})${d.contact_handle ? "" : ", no direct handle on file"}.`
      : `No named ${side} contact is on file.`
    add(ep.id, `${side}.contact`, contact, level, "endpoint_detail", at, by, statusNote("Contact", d.contact_status, level))
    if (str(d.access_instruction)) add(ep.id, `${side}.access_route`, String(d.access_instruction), level, "endpoint_detail", at, by, statusNote("Access", d.access_status, level))
  }
  for (const c of rows(bundle, "endpoint_claims")) {
    const d = c.details
    const rejected = String(d.resolution_status ?? "").startsWith("REJECTED")
    add(c.id, `claim.${d.field ?? "endpoint"}`, String(d.claim ?? ""), rejected ? "refuted" : "claimed", "endpoint_claim", iso(d.recorded_at), STATED_BY[String(d.source_type)] ?? "Reported")
  }
  for (const w of rows(bundle, "time_windows")) {
    const d = w.details
    if (d.is_selected !== true) continue
    const subject = d.purpose === "SELECTED_PICKUP_SLOT" ? "pickup.slot" : d.purpose === "CUSTOMER_DELIVERY_PROMISE" ? "delivery.promise" : `window.${String(d.purpose).toLowerCase()}`
    const what = d.purpose === "CUSTOMER_DELIVERY_PROMISE" ? "Delivery promise" : "Selected pickup slot"
    // A window that has ended is history, not a reservation: the pickup is done, or the slot went by.
    const past = !!now && str(d.end_at) && Date.parse(String(d.end_at)) < Date.parse(now)
    const gone = subject === "pickup.slot" ? (PRE_PICKUP.includes(bundle.order.status) ? "Slot has passed" : "Pickup done") : "Window has passed"
    add(w.id, subject, `${what}: ${fmtWindow(str(d.start_at), str(d.end_at), str(d.timezone), subject === "pickup.slot" ? "site time" : "local time at delivery", false)}.`, past ? "stale" : "reserved", "time_window", iso(d.stated_at) ?? iso(bundle.order.createdAt), d.source === "CUSTOMER" ? "Customer" : "Operations", past ? gone : null)
  }
  for (const a of rows(bundle, "work_assignments")) {
    const d = a.details
    if (d.status === "CANCELLED") continue
    const name = bundle.dir.driverName(d.driver_id) ?? String(d.driver_id)
    const state = d.status === "ASSIGNED" ? "is assigned" : d.status === "IN_PROGRESS" ? "is assigned and on the job" : `is assigned (${labelIn(String(d.status))})`
    add(a.id, "driver.assignment", `Driver ${name} ${state}.`, "reserved", "work_assignment", iso(d.accepted_at), "Dispatch")
  }
  const track = [...rows(bundle, "tracking_observations")].sort((x, y) => String(y.details.observed_at).localeCompare(String(x.details.observed_at)))[0]
  if (track) add(track.id, "car.position", `Last app position ${track.details.distance_remaining_km ?? "?"} km from delivery.`, "observed", "tracking", iso(track.details.observed_at), "Driver app")
  for (const p of rows(bundle, "proofs")) {
    const d = p.details
    const level: EvidenceLevel = d.status === "APPROVED" ? "verified" : d.status === "SUBMITTED" ? "observed" : "claimed"
    add(p.id, `proof.${String(d.kind ?? "file").toLowerCase()}`, `${label(String(d.kind ?? "PROOF"))} ${String(d.status).toLowerCase()}.`, level, "proof", iso(d.reviewed_at ?? d.submitted_at ?? d.updated_at ?? d.created_at), "Proof record")
  }
  for (const doc of rows(bundle, "documents")) {
    const d = doc.details
    if (d.kind !== "RELEASE_AUTHORITY") continue
    add(doc.id, "pickup.release_authority", d.status === "MISSING" ? "No signed release authority is on file." : `Release authority is ${String(d.status).toLowerCase()}.`,
      d.status === "VERIFIED" ? "verified" : "observed", "document", iso(d.updated_at), "Document record")
  }
  // An open incident's own record: what the driver reported, where, the warning photo and who decides recovery.
  for (const inc of rows(bundle, "incidents")) {
    const d = inc.details
    if (d.resolved_at) continue
    const at = iso(d.opened_at)
    const by = str(d.owner) ? bundle.dir.resolve(d.owner, "operator").name : "Incident record"
    if (str(d.reported_symptom)) add(inc.id, "incident.warning", `${String(d.reported_symptom).replace(/\.$/, "")} (driver's report).`, "claimed", "incident", at, by)
    if (str(d.reported_stop_text)) add(inc.id, "incident.location", `Where it stopped (driver's report): ${String(d.reported_stop_text).replace(/^driver reports (a |an )?/i, "a ").replace(/\.$/, "")}.`, "claimed", "incident", at, by,
      d.location_verified === true ? "Location verified" : "Location not verified")
    if (str(d.warning_photo_status) && d.warning_photo_status !== "RECEIVED") add(inc.id, "incident.photo", `Warning photo ${String(d.warning_photo_status).toLowerCase()}, not received yet.`, "observed", "incident", at, by)
    if (d.recovery_decision === "PENDING_CUSTOMER") add(inc.id, "incident.recovery", "Roadside or tow is the customer's call; no recovery is booked.", "observed", "incident", at, by)
  }
  for (const al of bundle.alerts) {
    if (al.status === "RESOLVED" || al.status === "DISMISSED") continue
    const level = alertLevel(al.summary)
    add(al.id, `alert.${al.signal.toLowerCase()}`, al.summary, level, "alert", al.triggeredAt, "Monitoring", `${level === "quoted" ? "Relays what the site said · " : ""}${alertNote(al.severity, al.status, str(al.details.owner) ? bundle.dir.resolve(al.details.owner, "operator").name : null)}`)
  }
  return out
}

/** An alert is Monitoring's reading of other records, so it carries the level of what it relays (CLAUDE.md rule 4):
 *  the site's own word is quoted, a missing driver-app position is an observation, and anything else (a driver's or
 *  customer's report, a "review this" flag) stays claimed. ponytail: reads the summary's wording; a signal → source
 *  table if the dataset's summaries change shape. */
export function alertLevel(summary: string): EvidenceLevel {
  if (/^site\b/i.test(summary)) return "quoted"
  if (/^no recent driver-app position/i.test(summary)) return "observed"
  return "claimed"
}

/** "Critical alert, acknowledged by Shift lead" rather than "critical acknowledged". */
function alertNote(severity: string, status: string, owner: string | null): string {
  const state = status === "ACKNOWLEDGED" ? `acknowledged${owner ? ` by ${owner}` : ""}` : status === "OPEN" ? "not yet acknowledged" : labelIn(status)
  return `${label(severity)} alert, ${state}`
}

/** Dataset + ring facts for one order, with supersession and ageing applied at `now`. */
export function orderFacts(bundle: Bundle, ring: RingOrderState, now: string): Fact[] {
  // An alert that an approved Ringo change answered is no longer the current story (its row stays open in the dataset).
  // An approved access record answers the "site access unconfirmed" alert even when the proposal did not name it.
  const done = ring.proposals.filter((p) => p.status === "EXECUTED")
  const settled = new Set([...done.flatMap((p) => (p.alertId ? [p.alertId] : [])),
    ...(done.some((p) => p.actionType === "endpoint.record_access") ? bundle.alerts.filter((a) => a.signal === "SITE_ACCESS_UNCONFIRMED").map((a) => a.id) : [])])
  const ds = datasetFacts(bundle, now).map((f) => {
    const s = ring.datasetSupersede[f.id]
    if (s) return { ...f, level: s.level, supersededByFactId: s.factId }
    return f.sourceKind === "alert" && settled.has(f.sourceId) ? { ...f, level: "stale" as const, note: "Answered by the approved change" } : f
  })
  // A site-access alert asks for a call ("stock-control callback pending"). Once Ringo's call to the site has quoted
  // a pickup fact after the alert was raised, the alert's story is overtaken: it folds into "no longer true", linked.
  const answer = (f: Fact) => /^alert\.site_access/.test(f.subject) && !f.supersededByFactId
    ? ring.facts.filter((r) => r.sourceKind === "ring_call" && r.level === "quoted" && !r.supersededByFactId && /^pickup\./.test(r.subject) && r.at > f.at).sort((x, y) => y.at.localeCompare(x.at))[0]
    : undefined
  const overtaken = ds.map((f) => {
    const by = answer(f)
    return by ? { ...f, level: "stale" as const, supersededByFactId: by.id, note: "Overtaken by Ringo's call to the site" } : f
  })
  return [...overtaken, ...ring.facts].map((f) => ({ ...f, level: effectiveLevel(f, now) }))
}

/** "What we know" in decision order (lib/triage/relevance.ts): facts the decision cites, then the ones that answer
 *  its words, open alerts, the order's stage, the rest, and contacts/photos last. Decide's "What matters" takes the
 *  top of the same list. `extra` adds what the story knows beyond triage: Ringo's headline, proposals and evidence. */
export function rankFacts(facts: Fact[], t: Pick<Triage, "sources" | "why" | "oneDecision">, status: string, extra: { text?: string[]; cited?: string[] } = {}): Fact[] {
  return rankByDecision(facts, {
    text: [t.why, t.oneDecision ?? "", ...(extra.text ?? [])].join(" "),
    cited: new Set([...t.sources.map((s) => s.id), ...(extra.cited ?? [])]),
    preCollection: PRE_PICKUP.includes(status),
  })
}
