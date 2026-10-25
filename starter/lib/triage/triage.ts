// Deterministic triage: who needs a person, and why (CONTRACT §4). No LLM.
// 12 ordered rules; the first match wins. Every result names its source rows.
import type { Fact, QueueBucket, SourceRef, Triage, TriageReason } from "@/lib/contract"
import { LEVEL_RANK } from "@/lib/agent/facts"
import type { RingOrderState } from "@/lib/agent/store"
import { rows, str, strings, type Bundle, type RelatedRow } from "@/lib/present/bundle"
import { orderFacts } from "./facts"
import { OPERATOR_ZONE, fmtClock, fmtRange } from "@/lib/present/time"

export const RING_KINDS = ["PICKUP_CONTACT_HANDLE_REQUIRED", "PICKUP_ACCESS_CHECK_REQUIRED", "KEY_HOLDER_STOCK_CHECK"]
const RING_STATUSES = ["NEW", "WAITING_FOR_PICKUP"]
const ORDER: TriageReason[] = ["SAFETY", "FAILED_ACTION", "AUTHORITY_BLOCKED", "DECISION_WAITING", "DRIVER_WAITING",
  "RECORDED_PROPOSAL", "CUSTOMER_CONTACT", "DUE_SOON", "RING_WORKING", "RING_CAN_CALL", "WAITING_EXTERNAL", "QUIET"]
const SEV = { critical: 0, high: 1, medium: 2, low: 3 } as const
type Sev = keyof typeof SEV

const ref = (table: string, id: string): SourceRef => ({ table, id })
// "11:22": the desk's clock (Helsinki). The screens say "Helsinki time" once per section, so no zone name per line.
const hhmm = (iso: string) => fmtClock(iso)
const openItems = (b: Bundle) => rows(b, "work_items").filter((w) => w.details.status === "OPEN" || w.details.status === "NEEDS_EXTERNAL_INPUT")
const openAlerts = (b: Bundle) => b.alerts.filter((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED")
const openIncidents = (b: Bundle) => rows(b, "incidents").filter((i) => !i.details.resolved_at)

/** The pickup site Ringo may call: the order's pickup site, or the site behind the pickup contact handle. */
export function pickupSiteId(b: Bundle): string | null {
  if (b.order.pickupSiteId) return b.order.pickupSiteId
  const ep = rows(b, "order_endpoint_details").find((e) => e.details.boundary === "PICKUP")
  const m = /^(site-\d+)@/.exec(String(ep?.details.contact_handle ?? ""))
  return m ? m[1] : null
}

/** How Ringo may work an order. "pickup": the full pickup-readiness job. "roadside": a car stopped on the road for
 *  safety; Ringo works driver-only and safety-limited (lib/agent/tools.ts ROADSIDE): he may ask the assigned driver if
 *  they are safe and where exactly they are, ask for the warning-light photo, and send one holding reply. No calls, no
 *  proposals, no advice; roadside or tow stays a person's decision. */
export type RingMode = "pickup" | "roadside"

export function ringEligibility(b: Bundle): { ok: boolean; reason: string | null; mode: RingMode | null } {
  if (openAlerts(b).some((a) => a.signal === "SAFETY_STOP") || openIncidents(b).some((i) => i.details.kind === "VEHICLE_WARNING")) {
    const driver = rows(b, "work_assignments").some((a) => a.details.status !== "CANCELLED" && str(a.details.driver_id))
    return driver ? { ok: true, reason: null, mode: "roadside" } : { ok: false, reason: "On-the-road safety with no assigned driver: a person owns this.", mode: null }
  }
  if (!RING_STATUSES.includes(b.order.status)) return { ok: false, reason: "Ringo works pickup readiness before collection only.", mode: null }
  if (!pickupSiteId(b)) return { ok: false, reason: "No pickup site or pickup contact to call.", mode: null }
  return { ok: true, reason: null, mode: "pickup" }
}

/** "I can wait another 30 minutes" → the time the driver said they leave. Only the driver's newest message counts. */
const WAIT = /\bwait(?: here)?(?: for)?(?: another| up to)? (\d{1,3}) (?:more )?min/i
export function driverWaitUntil(b: Bundle): { until: string; said: string; messageId: string } | null {
  const last = b.messages.filter((m) => m.authorType === "driver").sort((x, y) => x.authoredAt.localeCompare(y.authoredAt)).pop()
  const n = last && WAIT.exec(last.body)
  return n ? { until: new Date(Date.parse(last.authoredAt) + Number(n[1]) * 60_000).toISOString(), said: last.authoredAt, messageId: last.id } : null
}

/** The cutoff behind an open alert that has one: the ferry check-in for a ferry risk, the promise end for a promise at risk. */
function alertCutoffs(b: Bundle): string[] {
  const out: string[] = []
  for (const a of openAlerts(b)) {
    if (a.signal.startsWith("FERRY_")) for (const r of rows(b, "travel_reservations"))
      if (r.details.status === "BOOKED" && r.details.assignment_id === a.details.assignment_id && str(r.details.check_in_cutoff_at)) out.push(String(r.details.check_in_cutoff_at))
    if (a.signal.startsWith("DELIVERY_PROMISE_")) for (const t of rows(b, "time_windows"))
      if (t.details.is_selected === true && t.details.purpose === "CUSTOMER_DELIVERY_PROMISE" && str(t.details.end_at)) out.push(String(t.details.end_at))
  }
  return out
}

const earliest = (times: string[]) => times.map((t) => new Date(t).toISOString()).sort()[0] ?? null

// Hard deadlines first: open task due times, the time a waiting driver said they leave, an alert's cutoff.
// Only without one: the selected pickup slot start (before pickup) and the promise deadline.
// A pickup slot that already passed on a moving car is not a deadline.
export function decideBy(b: Bundle): string | null {
  const hard = [...openItems(b).flatMap((w) => (str(w.details.due_at) ? [String(w.details.due_at)] : [])), ...alertCutoffs(b)]
  const wait = driverWaitUntil(b)
  if (wait && RING_STATUSES.includes(b.order.status)) hard.push(wait.until)
  if (hard.length) return earliest(hard)
  const times: string[] = []
  for (const t of rows(b, "time_windows")) {
    if (t.details.is_selected !== true) continue
    if (t.details.purpose === "SELECTED_PICKUP_SLOT" && RING_STATUSES.includes(b.order.status) && str(t.details.start_at)) times.push(String(t.details.start_at))
    if (str(t.details.commitment_deadline_at)) times.push(String(t.details.commitment_deadline_at))
  }
  return earliest(times)
}

/** "Attempt to book the next-day crossing failed at 10:10 EEST: provider timed out without a confirmation reference." */
function failedDataset(p: RelatedRow): string {
  const exec = (p.details.execution ?? {}) as Record<string, unknown>
  const err = String(exec.error ?? "outcome unknown").split(/(?<=\.)\s/)[0].replace(/\.$/, "")
  const at = str(exec.attempted_at) ? ` at ${hhmm(new Date(String(exec.attempted_at)).toISOString())}` : ""
  return `${String(p.details.summary).replace(/\.$/, "")} failed${at}: ${err}.`
}

/** Alert summaries end in boilerplate ("; source is a conversation, not a verified outcome."). Keep the part that says what is wrong. */
const alertText = (summary: string) => summary.replace(/;\s*source is a conversation, not a verified outcome\.?$/i, ".")

type Hit = { reason: TriageReason; why: string; sources: SourceRef[]; severity?: Sev; oneDecision?: string | null; decideBy?: string }

/** What a person recorded on a safety card: the customer's roadside-or-tow choice (ring_events "recovery.choice"). */
export const RECOVERY_THEN: Record<string, string> = {
  roadside: "Book roadside assistance (it needs approval as a cost) and tell the driver who is coming.",
  tow: "Book the tow (it needs approval as a cost) and tell the driver who is coming.",
}

/** What a delay means downstream, from the order's own delivery window: on an in-transit order whose problem blocks the
 *  car (a safety stop, an open incident). "late" only once the window has ended; before that "at risk", since nothing
 *  in the records says how long the stop lasts. ponytail: no ETA model; a recovery time from the booking would sharpen it. */
export function deliveryImpact(b: Bundle, now: string): string | null {
  if (b.order.status !== "IN_TRANSIT") return null
  if (!openIncidents(b).length && !openAlerts(b).some((a) => a.signal === "SAFETY_STOP" || a.severity === "critical")) return null
  const sel = (purpose: string) => rows(b, "time_windows").find((t) => t.details.is_selected === true && t.details.purpose === purpose && str(t.details.end_at))
  const w = sel("SELECTED_DELIVERY_SLOT") ?? sel("CUSTOMER_DELIVERY_PROMISE")
  if (!w) return null
  const end = String(w.details.end_at)
  const range = fmtRange(String(w.details.start_at ?? end), end, OPERATOR_ZONE)
  const city = b.places.get(b.order.deliveryAddressId)?.city
  return `Delivery: ${city ? `to ${city}, ` : ""}due ${range.slice(0, range.lastIndexOf(" "))}: ${Date.parse(end) < Date.parse(now) ? "late" : "at risk"}; tell ${b.customer.name} when you call (reserved · ${w.details.purpose === "SELECTED_DELIVERY_SLOT" ? "delivery slot" : "delivery promise"})`
}

/** The short value of what the driver told Ringo, for the card's labelled lines; the full claim stays in What we know. */
function brief(f: Fact): string {
  const c = f.claim.replace(/\.$/, "")
  if (f.subject === "driver.safety") {
    const said = [/\bsafe\b/i.test(c) && "safe", /engine (is )?(off|switched off)/i.test(c) && "engine off"].filter(Boolean)
    if (said.length) return said.join(", ")
  }
  if (f.subject === "incident.location") {
    const parts = c.replace(/^driver says (that )?(the car is )?(at )?/i, "").split(/,\s*/)
    return [parts[0], ...parts.slice(1).filter((x) => /^(row|bay|lane|level|space|pump)\b/i.test(x)).map((x) => x.replace(/\s+near\b.*$/i, ""))].join(", ")
  }
  if (f.subject === "incident.photo" && /\bsending\b|on (its|the) way/i.test(c)) return /not (yet )?(seen|received)/i.test(c) ? "sending, not yet seen" : "sending"
  return c.replace(/^driver says (that )?/i, "")
}

/** The safety card: one labelled line per thing a person needs (Driver, Where, Photo, Customer, Delivery), each with
 *  its level and source in brackets, then the decision. What the driver told Ringo in roadside mode (claimed facts)
 *  is newer than the records and wins; the records fill the rest. app/components/ring/story.tsx draws the lines. */
function safetyDecision(b: Bundle, incident: RelatedRow | undefined, ring: RingOrderState, now: string): string {
  const chose = ring.events.filter((e) => e.command === "recovery.choice").pop()
  const choice = chose && String(chose.changes.choice)
  if (choice && RECOVERY_THEN[choice]) return `Customer chose ${choice === "tow" ? "a tow" : "roadside assistance"} (recorded ${hhmm(chose.at)} by ${chose.actorId}). ${RECOVERY_THEN[choice]}`
  const msgs = [...b.messages].sort((x, y) => x.authoredAt.localeCompare(y.authoredAt))
  const safe = msgs.filter((m) => m.authorType === "driver" && /\bsafe\b/i.test(m.body)).pop()
  const cust = msgs.filter((m) => m.authorType === "customer").pop()
  const heard = (subject: string) => ring.facts.filter((f) => f.subject === subject && !f.supersededByFactId && f.level !== "refuted").sort((x, y) => x.at.localeCompare(y.at)).pop()
  const told = (f: Fact) => `${brief(f)} (${f.level} · driver to Ringo ${hhmm(f.at)}, simulated)`
  const okNow = heard("driver.safety"), where = heard("incident.location"), pic = heard("incident.photo")
  const d = incident?.details ?? {}
  const lines = [
    `Driver: ${okNow ? told(okNow) : safe ? `safe, stopped (claimed · driver ${hhmm(safe.authoredAt)})` : "safety not yet confirmed (no driver message says so)"}`,
    `Where: ${where ? told(where) : `${d.location_verified === false ? "not verified" : "recorded"} (incident record)`}`,
    `Photo: ${pic ? told(pic) : `${d.warning_photo_status && d.warning_photo_status !== "RECEIVED" ? "requested, not received" : "received"} (observed · incident record)`}`,
  ]
  if (cust && /stop/i.test(cust.body)) lines.push(`Customer: keep it stopped (quoted · customer ${hhmm(cust.authoredAt)})`)
  const impact = deliveryImpact(b, now)
  if (impact) lines.push(impact)
  lines.push("Decide with the customer: roadside or tow.")
  return lines.join("\n")
}

// A driver message that asks for something. "Understood, no cost to submit" or a position update needs no answer.
const ASKS = /\?|\bplease\b|\b(can|could) you\b/i

/** A message, short: whole when it fits the row's two lines, else the sentence with the question, led by the sentence that says what is wrong when both fit. Filler ("Understood.") is dropped so the ask is never clamped away. */
export function quoteShort(body: string, max = 100): string {
  if (body.length <= max) return body
  const s = (body.match(/[^.!?]+[.!?]*/g) ?? [body]).map((x) => x.trim()).filter(Boolean)
  const ask = s.findLast((x) => ASKS.test(x)) ?? s[0]
  const lead = s.find((x) => x !== ask && /\b(cannot|can't|won't|not|no)\b/i.test(x))
  const text = lead && lead.length + ask.length < max ? `${lead} ${ask}` : ask
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** A queue row's title: at most `max` words. A text that fits stays whole; else its first clause (to ". ", "; " or
 *  ": ") when that says enough on its own; else the first words with "…", never ending on "and", "the" and the like.
 *  The full text stays on the order page and in the row's title attribute. */
const TAIL = /\s+(a|an|the|and|or|but|of|to|at|in|on|for|with|across|whether|are|is|was|were|be|been|has|have)$/i
export function shortHeadline(text: string, max = 12): string {
  const words = (x: string) => x.split(/\s+/).filter(Boolean).length
  if (words(text) <= max + 2) return text
  const clause = /^(.+?)[.;:]\s/.exec(text)?.[1]
  if (clause && words(clause) >= 4 && words(clause) <= max) return clause
  let cut = text.split(/\s+/).slice(0, max).join(" ").replace(/[,;:.]+$/, "")
  while (TAIL.test(cut)) cut = cut.replace(TAIL, "").replace(/[,;:.]+$/, "")
  return `${cut}…${(cut.match(/“/g)?.length ?? 0) > (cut.match(/”/g)?.length ?? 0) ? "”" : ""}`
}

const lcFirst = (x: string) => x.charAt(0).toLowerCase() + x.slice(1)

function unansweredDriver(b: Bundle, now: string) {
  const byThread = new Map<string, typeof b.messages>()
  for (const m of b.messages) byThread.set(m.conversationId, [...(byThread.get(m.conversationId) ?? []), m])
  for (const list of byThread.values()) {
    const last = [...list].filter((m) => m.authorType !== "internal" && m.details.visibility !== "INTERNAL").sort((x, y) => x.authoredAt.localeCompare(y.authoredAt)).pop()
    if (last?.authorType === "driver" && ASKS.test(last.body) && Date.parse(now) - Date.parse(last.authoredAt) <= 2 * 3600_000) return last
  }
  return null
}

function waitLine(b: Bundle, now: string): string | null {
  const w = driverWaitUntil(b)
  if (!w) return null
  return `${w.until > now ? "Driver leaves at" : "Driver could wait until"} ${hhmm(w.until)} (said ${hhmm(w.said)}).`
}

/** The open problem in the order's own records: the first open task outside Ringo's gaps, else Ringo's gap, else an open alert. */
function problemOf(b: Bundle): string | null {
  const items = openItems(b)
  const task = items.find((w) => !RING_KINDS.includes(String(w.details.kind)) && str(w.details.summary)) ?? items.find((w) => str(w.details.summary))
  if (task) return String(task.details.summary)
  const alert = openAlerts(b)[0]
  return alert ? alertText(alert.summary) : null
}

/** What the queue row says under Ringo's open proposal: the reason the order would have without it. */
function underProposal(b: Bundle, ring: RingOrderState, now: string): string | null {
  const without = { ...ring, proposals: ring.proposals.filter((p) => p.status !== "PENDING_REVIEW"), runs: ring.runs.filter((r) => r.status === "running") }
  const hit = rules(b, without, now)
  return hit.reason === "RING_CAN_CALL" || hit.reason === "RING_WORKING" || hit.reason === "WAITING_EXTERNAL" || hit.reason === "QUIET" ? problemOf(b) : hit.why
}

function rules(b: Bundle, ring: RingOrderState, now: string): Hit {
  const alerts = openAlerts(b), incidents = openIncidents(b), items = openItems(b)
  const dsProps = rows(b, "agent_proposals")

  // 1 SAFETY
  const crit = alerts.find((a) => a.severity === "critical")
  const warn = incidents.find((i) => i.details.kind === "VEHICLE_WARNING")
  if (crit || warn) return {
    reason: "SAFETY", severity: "critical",
    why: crit?.summary ?? "Open vehicle warning on the road. A person owns this.",
    sources: [...ring.events.filter((e) => e.command === "recovery.choice").slice(-1).map((e) => ref("ring_events", e.id)),
      ...(crit ? [ref("alerts", crit.id)] : []), ...(warn ? [ref("incidents", warn.id)] : [])],
    oneDecision: safetyDecision(b, warn, ring, now),
  }
  // 2 FAILED_ACTION
  const failed = [...dsProps.filter((p) => p.details.status === "FAILED").map((p) => ref("agent_proposals", p.id)),
    ...ring.proposals.filter((p) => p.status === "FAILED" || p.execution?.status === "STALE").map((p) => ref("ring_proposals", p.id))]
  const lastCall = ring.calls.filter((c) => c.status === "ended").pop()
  if (lastCall?.outcome === "DROPPED_UNKNOWN" && !ring.jobs.some((j) => j.status === "scheduled")) failed.push(ref("ring_calls", lastCall.id))
  if (failed.length) return {
    reason: "FAILED_ACTION", severity: "high", sources: failed,
    why: failed[0].table === "ring_calls" ? "Ringo's last call dropped with an unknown outcome and no reconciling call followed." :
      failed[0].table === "agent_proposals" ? failedDataset(dsProps.find((p) => p.id === failed[0].id)!) :
        "An approved change could not run because the order changed. Ringo must re-read first.",
  }
  // 3 AUTHORITY_BLOCKED
  const release = b.alerts.find((a) => a.status === "OPEN" && a.signal === "RELEASE_DOCUMENT_UNCLEAR")
  const hold = items.find((w) => w.details.kind === "COMMERCIAL_RELEASE_HOLD")
  if (release || hold) return {
    reason: "AUTHORITY_BLOCKED", severity: "high",
    why: hold ? "Seller hold: the customer must clear it and send a signed release before any driver goes." : "Release authority is unclear; only the customer or seller can clear it.",
    sources: [...(release ? [ref("alerts", release.id)] : []), ...(hold ? [ref("work_items", hold.id)] : []),
      ...((hold?.details.source_refs ?? []) as SourceRef[]).filter((r) => r.table === "messages")],
  }
  // 4 DECISION_WAITING
  const pending = ring.proposals.filter((p) => p.status === "PENDING_REVIEW")
  const lastRun = ring.runs.filter((r) => r.status !== "running" && r.decision?.outcome !== "failed").pop()
  if (pending.length || lastRun?.decision?.outcome === "needs_person") return {
    reason: "DECISION_WAITING", severity: "high",
    // A row states the problem as it stands now; Ringo's proposal goes in the chip ("Review Ringo's hold"). Once
    // Ringo has stopped, that is his headline, the same line the order's hero shows (ring:check holds the two
    // together). Only without a stop: what the order would say without his proposal, else the open gap itself.
    why: ring.runs.findLast((r) => r.decision && r.decision.outcome !== "failed")?.decision?.headline ?? (pending.length ? underProposal(b, ring, now) ?? pending[0].summary : ""),
    sources: pending.length ? pending.map((p) => ref("ring_proposals", p.id)) : [ref("ring_runs", lastRun!.id)],
    oneDecision: lastRun?.decision?.oneDecision ?? null,
  }
  // 5 DRIVER_WAITING
  const empty = incidents.find((i) => i.details.kind === "EMPTY_PICKUP")
  const driverMsg = unansweredDriver(b, now)
  if (empty || driverMsg) return {
    reason: "DRIVER_WAITING", severity: "high",
    why: empty ? `Driver is at the pickup but the car is not there. ${waitLine(b, now) ?? "They cannot wait much longer."}` : `Driver, ${hhmm(driverMsg!.authoredAt)}: “${quoteShort(driverMsg!.body)}”`,
    sources: [...(empty ? [ref("incidents", empty.id)] : []), ...(driverMsg ? [ref("messages", driverMsg.id)] : []),
      ...(empty && !driverMsg && driverWaitUntil(b) ? [ref("messages", driverWaitUntil(b)!.messageId)] : [])],
  }
  // 6 RECORDED_PROPOSAL
  const dsPending = dsProps.filter((p) => p.details.status === "PENDING_REVIEW")
  if (dsPending.length) return {
    reason: "RECORDED_PROPOSAL", severity: "medium", sources: dsPending.map((p) => ref("agent_proposals", p.id)),
    // The problem, not the fix: the open task or alert the recorded proposal answers. The chip says "Review recorded proposal".
    why: problemOf(b) ?? `Recorded proposal: ${String(dsPending[0].details.summary)}`,
  }
  // 7 CUSTOMER_CONTACT
  const identity = items.find((w) => w.details.kind === "IDENTITY_INPUT_REQUIRED")
  const custProp = ring.proposals.find((p) => p.status === "PENDING_REVIEW" && strings(p.proposedPayload.contact).includes("customer"))
  if (identity || custProp) return {
    reason: "CUSTOMER_CONTACT", severity: "medium",
    why: identity ? String(identity.details.summary ?? "The next step needs the customer, and only a person contacts them.") : "The next step needs the customer, and only a person contacts them.",
    sources: identity ? [ref("work_items", identity.id)] : [ref("ring_proposals", custProp!.id)],
  }
  // 8 DUE_SOON: a task due within the hour, or a high alert nobody has acknowledged yet (e.g. a promise that can't be kept)
  const due = items.find((w) => !RING_KINDS.includes(String(w.details.kind)) && str(w.details.due_at) && Date.parse(String(w.details.due_at)) - Date.parse(now) <= 3600_000)
  const unacked = alerts.find((a) => a.status === "OPEN" && a.severity === "high" && a.signal !== "SITE_ACCESS_UNCONFIRMED")
  if (!due && unacked) {
    // Generated summaries ("Review ferry cutoff for CD-…") say little; quote the message that raised the alert instead.
    const raised = b.messages.filter((m) => m.conversationId === unacked.details.conversation_id && m.authorType !== "operator" && m.authorType !== "internal" && m.authoredAt <= unacked.triggeredAt)
      .sort((x, y) => x.authoredAt.localeCompare(y.authoredAt)).pop()
    const who = raised && (raised.authorType === "site_contact" ? "Site" : raised.authorType.replace(/^\w/, (c) => c.toUpperCase()))
    return { reason: "DUE_SOON", severity: "high", sources: [ref("alerts", unacked.id), ...(raised ? [ref("messages", raised.id)] : [])],
      why: raised && /^Review /.test(unacked.summary) ? `${who}, ${hhmm(raised.authoredAt)}: “${quoteShort(raised.body)}”` : alertText(unacked.summary) }
  }
  if (due) return {
    reason: "DUE_SOON", severity: due.details.priority === "high" ? "high" : "medium", sources: [ref("work_items", due.id)],
    why: String(due.details.summary ?? due.details.next_action),
  }
  // 8b A person's open follow-up ("I'll handle it", or the step a decision handed them): it stays theirs until they
  // close it. It sits in Taken while the claim holds and comes back due at its recheck time, or as soon as something
  // new happens. ponytail: one desk, so "Your follow-up"; name the desk when there are several.
  const follow = ring.claims.filter((c) => !c.releasedAt).sort((x, y) => x.at.localeCompare(y.at)).pop()
  if (follow) return {
    reason: "DUE_SOON", severity: "medium", decideBy: follow.recheckAt, sources: [ref("ring_claims", follow.id)],
    why: `Your follow-up: ${follow.note ?? "you said you would handle it"}`.replace(/\.?$/, "."),
  }
  // 9 RING_WORKING
  const live = ring.runs.find((r) => r.status === "running")
  const job = ring.jobs.find((j) => j.status === "scheduled")
  if (live || job) return {
    reason: "RING_WORKING", severity: "low",
    why: live ? "Ringo is working on this now." : `Ringo calls back at ${hhmm(job!.dueAt)}: ${job!.reason}`,
    sources: [live ? ref("ring_runs", live.id) : ref("ring_jobs", job!.id)],
  }
  // 10 RING_CAN_CALL (skipped once a Ringo change for this gap was executed)
  const gap = items.find((w) => RING_KINDS.includes(String(w.details.kind)))
  const access = b.alerts.find((a) => a.status === "OPEN" && a.signal === "SITE_ACCESS_UNCONFIRMED")
  const worked = ring.proposals.some((p) => p.status === "EXECUTED")
  if ((gap || access) && !worked && RING_STATUSES.includes(b.order.status) && pickupSiteId(b)) return {
    reason: "RING_CAN_CALL", severity: "low",
    why: gap ? `Ringo can call the site to ${lcFirst(String(gap.details.next_action ?? gap.details.summary))}` : `Ringo can call the site: ${access!.summary}`,
    sources: [...(gap ? [ref("work_items", gap.id)] : []), ...(access ? [ref("alerts", access.id)] : [])],
  }
  // 11 WAITING_EXTERNAL (an open lower alert is in hand, not quiet: the quiet count promises "no open alert")
  const ack = alerts.find((a) => a.status === "ACKNOWLEDGED" && str(a.details.owner)) ?? alerts[0]
  const waitingThread = b.conversations.find((c) => c.status === "OPEN" && str(c.details.waiting_on))
  if (ack || waitingThread) return {
    reason: "WAITING_EXTERNAL", severity: "low",
    why: waitingThread ? `Waiting on ${String(waitingThread.details.waiting_on).toLowerCase().replace(/_/g, " ")}${str(waitingThread.details.next_check_at) ? `, next check ${hhmm(String(waitingThread.details.next_check_at))}` : ""}.` : `${str(ack!.details.owner) ? `${ack!.details.owner} owns it` : b.conversations.some((c) => c.id === ack!.details.conversation_id && c.status === "OPEN") ? "Being followed up in the conversation" : "Open alert"}: ${alertText(ack!.summary)}`,
    sources: waitingThread ? [ref("conversations", waitingThread.id)] : [ref("alerts", ack!.id)],
  }
  return { reason: "QUIET", severity: "low", why: "Nothing needs a person.", sources: [] }
}

const BUCKET: Record<TriageReason, QueueBucket> = {
  SAFETY: "needs_you", FAILED_ACTION: "needs_you", AUTHORITY_BLOCKED: "needs_you", DECISION_WAITING: "needs_you",
  DRIVER_WAITING: "needs_you", RECORDED_PROPOSAL: "needs_you", CUSTOMER_CONTACT: "needs_you", DUE_SOON: "needs_you",
  RING_WORKING: "ring", RING_CAN_CALL: "ring", WAITING_EXTERNAL: "waiting", QUIET: "quiet",
}

function overtaken(b: Bundle): Triage["overtaken"] {
  const out: Triage["overtaken"] = []
  for (const gap of b.alerts.filter((a) => a.status === "OPEN" && a.signal === "TRACKING_GAP")) {
    const asg = gap.details.assignment_id
    const later = [
      ...b.alerts.filter((a) => a.id !== gap.id && a.details.assignment_id === asg && a.triggeredAt > gap.triggeredAt).map((a) => ({ ref: ref("alerts", a.id), at: a.triggeredAt })),
      ...rows(b, "incidents").filter((i) => i.details.assignment_id === asg && String(i.details.opened_at) > gap.triggeredAt).map((i) => ({ ref: ref("incidents", i.id), at: new Date(String(i.details.opened_at)).toISOString() })),
    ].sort((x, y) => x.at.localeCompare(y.at))[0]
    if (later) out.push({ ref: ref("alerts", gap.id), label: `Tracking gap ${hhmm(gap.triggeredAt)}`, overtakenBy: later.ref, overtakenAt: later.at })
  }
  return out
}

function chips(facts: Fact[], sources: SourceRef[]): Fact[] {
  const ids = new Set(sources.map((s) => s.id))
  return facts.filter((f) => (!f.supersededByFactId || f.level === "refuted") && f.level !== "stale")
    .sort((x, y) => Number(ids.has(y.sourceId)) - Number(ids.has(x.sourceId)) || Number(y.origin === "ring") - Number(x.origin === "ring")
      || LEVEL_RANK[y.level] - LEVEL_RANK[x.level] || y.at.localeCompare(x.at))
    .slice(0, 3)
}

export function triage(b: Bundle, ring: RingOrderState, now: string, facts?: Fact[]): Triage {
  const hit = rules(b, ring, now)
  const all = facts ?? orderFacts(b, ring, now)
  const sev: Sev = hit.severity ?? "low"
  const ownerItem = openItems(b)[0]
  return {
    orderId: b.order.id, reference: b.order.reference, bucket: BUCKET[hit.reason], reason: hit.reason, why: hit.why,
    rank: 0, severity: sev, decideBy: hit.decideBy ?? decideBy(b), ownerDesk: (str(ownerItem?.details.owner) ?? null) as Triage["ownerDesk"],
    sources: hit.sources, chips: hit.reason === "QUIET" ? [] : chips(all, hit.sources), overtaken: overtaken(b),
    oneDecision: hit.oneDecision ?? null,
    pendingProposalIds: [...ring.proposals.filter((p) => p.status === "PENDING_REVIEW").map((p) => p.id),
      ...rows(b, "agent_proposals").filter((p) => p.details.status === "PENDING_REVIEW").map((p) => p.id)],
  }
}

/** Sort and rank one bucket: reason order, then severity, then decideBy. */
export function rankAll<T extends Triage>(list: T[]): T[] {
  const sorted = [...list].sort((a, b) => ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason) || SEV[a.severity] - SEV[b.severity]
    || (a.decideBy ?? "9").localeCompare(b.decideBy ?? "9") || a.reference.localeCompare(b.reference))
  return sorted.map((t, i) => ({ ...t, rank: i + 1 }))
}
