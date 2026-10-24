// Which pending Ringo proposals a person may review in one go (decide mode's "Review N similar together").
// Pure; safe in client components. Each approval is still sent and recorded per proposal.
import type { ActionType, Proposal } from "@/lib/contract"

// Only the unlocked "ask" rows of the trust ledger. Locked ones (address, date, booking, cost, customer message)
// touch the customer or money, so each gets its own look; "auto" and "never" rows never wait for review.
const BATCHABLE: ActionType[] = ["endpoint.record_access", "endpoint.record_contact", "pickup.hold", "driver.instruct"]

/** Same shape = same kind of change, on the same fields, under the same reviewer conditions. The free-text
 *  rationale differs per order (other site, other names), so it is compared by what it argues for, not word by word.
 *  null when the proposal can't be batched: not Ringo's, not pending, locked, or blocked by the gate. */
export function similarKey(p: Proposal): string | null {
  if (p.origin !== "ring" || p.status !== "PENDING_REVIEW" || !p.actionType || !BATCHABLE.includes(p.actionType)) return null
  const findings = p.gate?.findings ?? []
  if (findings.some((f) => f.effect === "block")) return null
  return [p.actionType, Object.keys(p.proposedPayload).sort().join(","), findings.map((f) => f.ruleId).sort().join(",")].join("|")
}

/** Groups of two or more similar proposals, in the order given. */
export function similarGroups(proposals: Proposal[]): Proposal[][] {
  const groups = new Map<string, Proposal[]>()
  for (const p of proposals) {
    const k = similarKey(p)
    if (k) groups.set(k, [...(groups.get(k) ?? []), p])
  }
  return [...groups.values()].filter((g) => g.length > 1)
}
