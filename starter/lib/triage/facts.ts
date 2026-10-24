// Dataset facts: derived from structured rows only (CONTRACT §3). Facts read
// from message text come only from Ring's record_fact.
import type { EvidenceLevel, Fact } from "@/lib/contract"
import { effectiveLevel } from "@/lib/agent/facts"
import type { RingOrderState } from "@/lib/agent/store"
import { rows, str, type Bundle } from "@/lib/present/bundle"
import { label } from "@/lib/present/labels"
import { fmtRange } from "@/lib/present/time"

const STATED_BY: Record<string, string> = {
  MANAGED_SITE_PROFILE: "Site profile", SITE_CONTACT: "Site contact", CUSTOMER_ORDER_INPUT: "Customer order input",
}
const iso = (v: unknown) => (typeof v === "string" ? new Date(v).toISOString() : null)

export function datasetFacts(bundle: Bundle): Fact[] {
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
    add(ep.id, `${side}.contact`, contact, level, "endpoint_detail", at, by, `Contact ${String(d.contact_status ?? "").toLowerCase()}`)
    if (str(d.access_instruction)) add(ep.id, `${side}.access_route`, String(d.access_instruction), level, "endpoint_detail", at, by, `Access ${String(d.access_status ?? "").toLowerCase().replace(/_/g, " ")}`)
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
    add(w.id, subject, `${what}: ${fmtRange(str(d.start_at), str(d.end_at), str(d.timezone))}.`, "reserved", "time_window", iso(d.stated_at) ?? iso(bundle.order.createdAt), d.source === "CUSTOMER" ? "Customer" : "Operations")
  }
  for (const a of rows(bundle, "work_assignments")) {
    const d = a.details
    if (d.status === "CANCELLED") continue
    const name = bundle.dir.driverName(d.driver_id) ?? String(d.driver_id)
    add(a.id, "driver.assignment", `Driver ${name} is assigned (${String(d.status).toLowerCase().replace(/_/g, " ")}).`, "reserved", "work_assignment", iso(d.accepted_at), "Dispatch")
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
  for (const al of bundle.alerts) {
    if (al.status === "RESOLVED" || al.status === "DISMISSED") continue
    add(al.id, `alert.${al.signal.toLowerCase()}`, al.summary, "claimed", "alert", al.triggeredAt, "Monitoring", `${al.severity} ${al.status.toLowerCase()}`)
  }
  return out
}

/** Dataset + ring facts for one order, with supersession and ageing applied at `now`. */
export function orderFacts(bundle: Bundle, ring: RingOrderState, now: string): Fact[] {
  const ds = datasetFacts(bundle).map((f) => {
    const s = ring.datasetSupersede[f.id]
    return s ? { ...f, level: s.level, supersededByFactId: s.factId } : f
  })
  return [...ds, ...ring.facts].map((f) => ({ ...f, level: effectiveLevel(f, now) }))
}
