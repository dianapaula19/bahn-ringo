// The concrete next step a queue row asks for, as a short verb phrase ("Answer driver").
// Built only from the triage result, so it never says more than the rows behind it.
// null when nothing concrete can be said: the row shows no chip rather than "A person must act".
import type { Triage } from "@/lib/contract"

type Input = Pick<Triage, "reason" | "why" | "oneDecision" | "sources">

const has = (t: Input, table: string) => t.sources.some((s) => s.table === table)

export function nextAction(t: Input): string | null {
  switch (t.reason) {
    case "SAFETY": return /roadside or tow/i.test(t.oneDecision ?? "") ? "Decide: roadside or tow" : "Check on the driver"
    case "FAILED_ACTION":
      if (has(t, "ring_calls")) return "Check the dropped call"
      if (has(t, "ring_proposals")) return "Run Ringo again"
      return /\bbook/i.test(t.why) ? "Check failed booking" : "Check what failed"
    case "AUTHORITY_BLOCKED": return "Confirm with customer"
    case "DECISION_WAITING": return has(t, "ring_proposals") ? "Review proposal" : "Answer Ringo"
    case "DRIVER_WAITING": return "Answer driver"
    case "RECORDED_PROPOSAL": return "Review proposal"
    case "CUSTOMER_CONTACT": return "Confirm with customer"
    case "DUE_SOON": return dueSoon(t.why)
    case "RING_CAN_CALL": return "Run Ringo"
    default: return null
  }
}

// ponytail: keyword match on the task summary; a work-item kind → action table if these start misfiring.
function dueSoon(why: string): string | null {
  const quoted = /^(Driver|Site|Customer), \d\d:\d\d [A-Z+\d-]+:/.exec(why)?.[1]
  if (quoted) return quoted === "Driver" ? "Answer driver" : quoted === "Site" ? "Call site" : "Reply to customer"
  if (/\b(photo|proof|handover record)/i.test(why)) return "Check proof"
  if (/\b(customer|buyer)\b/i.test(why)) return "Confirm with customer"
  if (/\bsite\b/i.test(why)) return "Call site"
  if (/driver has not confirmed/i.test(why)) return "Call driver"
  return null
}

const NOW_WINDOW = 2 * 3600_000

/** The queue's "Now" group: safety always; otherwise critical/high severity that is overdue or due within 2 h.
 *  Everything else in Needs you is "When you can" (still needs a person, just not this minute). */
export function inNow(t: Pick<Triage, "reason" | "severity" | "decideBy">, now: string): boolean {
  if (t.reason === "SAFETY") return true
  if ((t.severity !== "critical" && t.severity !== "high") || !t.decideBy) return false
  return Date.parse(t.decideBy) - Date.parse(now) <= NOW_WINDOW
}
