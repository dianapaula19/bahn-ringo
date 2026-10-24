"use client"

import type { ActionType, EvidenceLevel, Fact, QueueItem, StoryEntry, TriageReason, TrustMode } from "@/lib/contract"
import { dayKey, fmtClock, fmtDateTime, fmtLong, relativeTo } from "@/lib/present/time"
import type { Tone } from "@/lib/present/types"
import { LizardFace, type Lizard } from "../ringo"

export const LEVEL: Record<EvidenceLevel, { label: string; tone: Tone; hint: string }> = {
  claimed: { label: "Claimed", tone: "neutral", hint: "Someone said it. Nobody has checked." },
  quoted: { label: "Quoted", tone: "accent", hint: "The site or provider stated it directly. Time-bound." },
  reserved: { label: "Reserved", tone: "accent", hint: "A booking or selected slot exists." },
  observed: { label: "Observed", tone: "ok", hint: "A physical signal: tracking, scan, photo or event." },
  verified: { label: "Verified", tone: "ok", hint: "Approved proof or a person's recorded check." },
  stale: { label: "Out of date", tone: "neutral", hint: "Too old, or overtaken by a later fact." },
  refuted: { label: "Refuted", tone: "danger", hint: "A later source contradicts it." },
}

export const ACTION: Record<ActionType, string> = {
  "call.site": "Call a pickup site",
  "driver.ask": "Ask the driver a question",
  "driver.instruct": "Tell the driver what to do",
  "endpoint.record_contact": "Record a pickup contact",
  "endpoint.record_access": "Record pickup access or key holder",
  "pickup.hold": "Hold a pickup",
  "address.update": "Change an address",
  "slot.change": "Change a date or slot",
  "booking.change": "Change a booking",
  "cost.approve": "Approve a cost",
  "customer.message": "Message the customer",
  diagnosis: "Give mechanical advice",
  attribution: "Assign blame",
  "booking.cancel": "Cancel a booking",
}

export const MODE: Record<TrustMode, { label: string; tone: Tone }> = {
  auto: { label: "Ringo does it", tone: "ok" },
  ask: { label: "Ask a person first", tone: "warn" },
  never: { label: "Never", tone: "danger" },
}

const STATUS: Record<TriageReason, { text: string; tone: Tone }> = {
  SAFETY: { text: "Safety: a person owns it", tone: "danger" },
  FAILED_ACTION: { text: "Failed: check first", tone: "danger" },
  AUTHORITY_BLOCKED: { text: "Customer must clear it", tone: "warn" },
  DECISION_WAITING: { text: "Ringo needs your decision", tone: "accent" },
  RECORDED_PROPOSAL: { text: "Proposal to review", tone: "warn" },
  DRIVER_WAITING: { text: "Driver is waiting", tone: "warn" },
  CUSTOMER_CONTACT: { text: "Customer contact needed", tone: "warn" },
  DUE_SOON: { text: "A person must act", tone: "warn" },
  RING_CAN_CALL: { text: "Ringo can call", tone: "accent" },
  RING_WORKING: { text: "Ringo is working", tone: "accent" },
  WAITING_EXTERNAL: { text: "Waiting on a reply", tone: "neutral" },
  QUIET: { text: "Fine", tone: "ok" },
}

export const agentStatus = (q: Pick<QueueItem, "reason">) => STATUS[q.reason]

/** "08:24 UTC" when it is the same day as now, else "19 Oct 10:44 UTC". */
export function When({ at, now }: { at: string | null | undefined; now?: string | null }) {
  if (!at) return null
  const text = now && dayKey(at) === dayKey(now) ? `${fmtClock(at)} UTC` : fmtDateTime(at)
  return <time dateTime={at} title={fmtLong(at)}>{text}</time>
}

export function Ago({ at, now }: { at: string | null | undefined; now: string | null | undefined }) {
  const rel = relativeTo(at, now)
  return rel ? <time dateTime={at!} title={fmtLong(at)}>{rel.text}</time> : null
}

export function Level({ level }: { level: EvidenceLevel }) {
  const l = LEVEL[level]
  return <span className={`chip tone-${l.tone}`} title={l.hint}>{l.label}</span>
}

/** A fact with its level, who said it and when. Superseded facts are struck through. */
const KIND: Partial<Record<Fact["sourceKind"], string>> = {
  message: "message", order_note: "order note", endpoint_detail: "pickup/delivery record", endpoint_claim: "address claim", site_profile: "site profile",
  alert: "alert", incident: "incident", work_item: "task", time_window: "slot record", work_assignment: "assignment", travel_option: "travel quote",
  travel_reservation: "booking", tracking: "driver app", proof: "proof", document: "document", event: "order event", ring_call: "Ringo call", ring_driver_message: "driver chat",
}

/** Which lizard speaks for a timeline entry. Bahn people, monitoring and system events get none. */
export const LIZARD: Partial<Record<StoryEntry["actorKind"], Lizard>> = { ring: "ringo", driver: "driver", customer: "customer", site: "dealer" }

/** Which lizard stands behind a fact's source. Messages take their author's role from the timeline;
 *  a Ringo call is what the site said, so the dealer; dataset records go by who stated them. */
export function factLizard(fact: Fact, entryKind: Map<string, StoryEntry["actorKind"]>): Lizard | null {
  if (fact.sourceKind === "ring_call") return "dealer"
  const kind = entryKind.get(fact.sourceId)
  if ((fact.sourceKind === "message" || fact.sourceKind === "ring_driver_message") && kind) return LIZARD[kind] ?? null
  if (/^customer/i.test(fact.by)) return "customer"
  if (/^site (profile|contact)/i.test(fact.by)) return "dealer"
  return null
}

/** A fact with its level, who said it, from which record, and when. Superseded facts are struck through.
 *  When the source is on the timeline (`linked`), the source names links to it. */
export function FactChip({ fact, now, linked, old: forceOld, who }: { fact: Fact; now?: string | null; linked?: Set<string>; old?: boolean; who?: Lizard | null }) {
  const old = forceOld || fact.level === "refuted" || fact.level === "stale" || !!fact.supersededByFactId
  const kind = KIND[fact.sourceKind] ?? "record"
  return <span className={`fact-chip${old ? " old" : ""}`}>
    <Level level={fact.level} />
    <span className="fact-claim">{fact.claim}</span>
    <span className="fact-src" title={`Source: ${fact.sourceId}`}>{who !== undefined && <LizardFace who={who} name={fact.by} />}{fact.by} · {linked?.has(fact.sourceId) ? <a href={`#src-${fact.sourceId}`}>{kind}</a> : kind} · <When at={fact.at} now={now} /></span>
  </span>
}

export function Simulated({ children = "Simulated" }: { children?: string }) {
  return <span className="chip tone-neutral sim-tag" title="Fictional, played by a simulator. No real person was contacted.">{children}</span>
}
