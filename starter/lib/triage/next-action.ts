// The concrete next step a queue row asks for, as a short verb phrase ("Answer driver").
// Built only from the triage result, so it never says more than the rows behind it.
// null when nothing concrete can be said: the row shows no chip rather than "A person must act".
import type { StoryEntry, Triage } from "@/lib/contract"

/** A queue row also carries the action type of Ringo's open proposal (lib/agent/story.ts), so the chip can name it. */
export type WithProposal = { proposalAction?: string | null }
type Input = Pick<Triage, "reason" | "why" | "oneDecision" | "sources"> & WithProposal

const has = (t: Input, table: string) => t.sources.some((s) => s.table === table)

// The proposal is the chip, the problem is the row's text.
const REVIEW: Record<string, string> = {
  "pickup.hold": "Review Ringo's hold", "endpoint.record_access": "Review the access note", "endpoint.record_contact": "Review the new contact",
  "address.update": "Review the address", "driver.instruct": "Review the driver message", "slot.change": "Review the new slot",
}

export function nextAction(t: Input): string | null {
  switch (t.reason) {
    case "SAFETY": return /roadside or tow/i.test(t.oneDecision ?? "") ? "Decide: roadside or tow" : /^Customer chose/.test(t.oneDecision ?? "") ? "Book recovery" : "Check on the driver"
    case "FAILED_ACTION":
      if (has(t, "ring_calls")) return "Check the dropped call"
      if (has(t, "ring_proposals")) return "Run Ringo again"
      return /\bbook/i.test(t.why) ? "Check failed booking" : "Check what failed"
    case "AUTHORITY_BLOCKED": return "Confirm with customer"
    case "DECISION_WAITING": return has(t, "ring_proposals") ? REVIEW[t.proposalAction ?? ""] ?? "Review Ringo's proposal" : "Answer Ringo"
    case "DRIVER_WAITING": return "Answer driver"
    case "RECORDED_PROPOSAL": return "Do it by hand"
    case "CUSTOMER_CONTACT": return "Confirm with customer"
    case "DUE_SOON": return dueSoonStep(t.why)
    case "RING_CAN_CALL": return "Run Ringo"
    default: return null
  }
}

// ponytail: keyword match on the task summary; a work-item kind → action table if these start misfiring.
function dueSoonStep(why: string): string | null {
  if (why.startsWith("Your follow-up:")) return "Your follow-up"
  const quoted = /^(Driver|Site|Customer), \d\d:\d\d(?: [A-Z+\d-]+)?:/.exec(why)?.[1]
  if (quoted) return quoted === "Driver" ? "Answer driver" : quoted === "Site" ? "Call site" : "Reply to customer"
  if (/\b(photo|proof|handover record)/i.test(why)) return "Check proof"
  if (/\b(customer|buyer)\b/i.test(why)) return "Confirm with customer"
  if (/\bsite\b/i.test(why)) return "Call site"
  if (/driver has not confirmed/i.test(why)) return "Call driver"
  if (/\bdriver\b/i.test(why)) return "Check driver plan"
  if (/\b(release|keys?|receipt|handover)\b/i.test(why)) return "Check release"
  if (/\b(promise|window|ferry|crossing|queue|terminal)\b/i.test(why)) return "Replan with customer"
  return null
}

const NOW_WINDOW = 2 * 3600_000
const SOON_WINDOW = 30 * 60_000

/** The queue's "Now" group: safety always, anything overdue or due within 30 min (any severity), and
 *  critical/high severity due within 2 h. Everything else in Needs you is "When you can". */
export function inNow(t: Pick<Triage, "reason" | "severity" | "decideBy">, now: string): boolean {
  if (t.reason === "SAFETY") return true
  if (!t.decideBy) return false
  const left = Date.parse(t.decideBy) - Date.parse(now)
  // "When you can" never holds a row that says "Overdue" or "Due in 10 min".
  return left <= SOON_WINDOW || ((t.severity === "critical" || t.severity === "high") && left <= NOW_WINDOW)
}

/** Due within 30 min and not yet overdue: the row's quiet "due soon" marker. */
export function dueSoon(t: Pick<Triage, "decideBy">, now: string): boolean {
  if (!t.decideBy) return false
  const left = Date.parse(t.decideBy) - Date.parse(now)
  return left >= 0 && left <= SOON_WINDOW
}

/** Now's order: a safety row (someone on the road) leads; then by deadline, overdue first (oldest deadline first),
 *  then the soonest; a row without a deadline goes last. Ties keep rank order (the sort is stable). */
export function byDeadline<T extends Pick<Triage, "reason" | "decideBy">>(rows: T[]): T[] {
  const key = (t: T) => t.reason === "SAFETY" ? -Infinity : t.decideBy ? Date.parse(t.decideBy) : Infinity
  return [...rows].sort((a, b) => key(a) - key(b))
}

/** The newest inbound driver line with no reply after it (from an operator, an agent or Ringo), for the hero's
 *  "Unanswered:" line. Only messages count: monitoring, site lines and recorded decisions are not replies. null when the driver has been answered. */
export function unanswered(timeline: Pick<StoryEntry, "actorKind" | "actor" | "at" | "text" | "ref">[]): Pick<StoryEntry, "actor" | "at" | "text" | "ref"> | null {
  const said = timeline.filter((e) => e.ref.table === "messages" || e.ref.table === "ring_driver_messages").sort((x, y) => x.at.localeCompare(y.at))
  const i = said.findLastIndex((e) => e.actorKind === "driver")
  if (i < 0 || said.slice(i + 1).some((e) => e.actorKind === "operator" || e.actorKind === "agent" || e.actorKind === "ring")) return null
  return said[i]
}
