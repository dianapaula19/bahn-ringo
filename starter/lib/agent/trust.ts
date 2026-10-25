// Trust ledger: auto / ask / never per action type. Locked rows (bookings,
// dates, costs, customer messages, every "never") can never be promoted.
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import type { ActionType, Desk, Proposal, TrustMode, TrustRow, TrustUpdateResponse } from "@/lib/contract"
import { ringProposals, ringTrust } from "@/lib/ring-schema"
import { toProposal } from "./store"

const L = (reason: string) => ({ locked: true, lockedReason: reason })
export const TRUST_DEFAULTS: Record<ActionType, { mode: TrustMode; locked: boolean; lockedReason: string | null }> = {
  "call.site": { mode: "auto", locked: false, lockedReason: null },
  "driver.ask": { mode: "auto", locked: false, lockedReason: null },
  "driver.instruct": { mode: "ask", locked: false, lockedReason: null },
  "endpoint.record_contact": { mode: "ask", locked: false, lockedReason: null },
  "endpoint.record_access": { mode: "ask", locked: false, lockedReason: null },
  "pickup.hold": { mode: "ask", locked: false, lockedReason: null },
  "address.update": { mode: "ask", ...L("Customer input: a person confirms with the customer first.") },
  "slot.change": { mode: "ask", ...L("Changes a date.") },
  "booking.change": { mode: "ask", ...L("Changes a booking.") },
  "cost.approve": { mode: "ask", ...L("Commits money.") },
  "customer.message": { mode: "ask", ...L("Only a person contacts the customer.") },
  diagnosis: { mode: "never", ...L("No mechanical advice.") },
  attribution: { mode: "never", ...L("No blame from photos.") },
  "booking.cancel": { mode: "never", ...L("Prepare, don't cancel.") },
}
export const ACTION_TYPES = Object.keys(TRUST_DEFAULTS) as ActionType[]

export async function trustMode(actionType: ActionType): Promise<TrustMode> {
  const [row] = await db.select().from(ringTrust).where(eq(ringTrust.actionType, actionType))
  const def = TRUST_DEFAULTS[actionType]
  return def.locked ? def.mode : ((row?.mode as TrustMode | undefined) ?? def.mode)
}

function counts(actionType: ActionType, proposals: Proposal[]) {
  const reviews = proposals.filter((p) => p.actionType === actionType && p.review).sort((a, b) => a.review!.reviewedAt.localeCompare(b.review!.reviewedAt))
  const unchanged = (p: Proposal) => p.review!.decision === "APPROVED"
  const last5 = reviews.slice(-5)
  return {
    approvedUnchanged: reviews.filter(unchanged).length,
    edited: reviews.filter((p) => p.review!.decision === "EDITED").length,
    rejected: reviews.filter((p) => p.review!.decision === "REJECTED").length,
    streak: last5.length === 5 && last5.every(unchanged),
    /** Unchanged approvals since the last edit or rejection: the progress toward promotion (5). */
    cleanRun: reviews.length - 1 - reviews.findLastIndex((p) => !unchanged(p)),
  }
}

export type LedgerRow = TrustRow & { cleanRun: number }

export async function ledger(now: string): Promise<LedgerRow[]> {
  const [rows, props] = await Promise.all([db.select().from(ringTrust), db.select().from(ringProposals)])
  const proposals = props.map(toProposal)
  return ACTION_TYPES.map((actionType) => {
    const def = TRUST_DEFAULTS[actionType]
    const row = rows.find((r) => r.actionType === actionType)
    const c = counts(actionType, proposals)
    const mode = def.locked ? def.mode : ((row?.mode as TrustMode | undefined) ?? def.mode)
    return {
      actionType, mode, locked: def.locked, lockedReason: def.lockedReason,
      approvedUnchanged: c.approvedUnchanged, edited: c.edited, rejected: c.rejected,
      promotable: !def.locked && mode === "ask" && c.approvedUnchanged >= 5 && c.streak, cleanRun: c.cleanRun,
      updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : now,
    }
  })
}

export async function updateTrust(actionType: ActionType, mode: TrustMode, operatorId: Desk, now: string): Promise<TrustUpdateResponse> {
  const def = TRUST_DEFAULTS[actionType]
  if (!def) return { error: "Unknown action type.", code: "LOCKED" }
  if (def.locked) return { error: `${actionType} is locked: ${def.lockedReason}`, code: "LOCKED" }
  const current = (await ledger(now)).find((r) => r.actionType === actionType)!
  if (mode === "auto" && current.mode !== "auto" && !current.promotable)
    return { error: "Promotion to auto needs 5 unchanged approvals in a row.", code: "NOT_PROMOTABLE" }
  await db.insert(ringTrust).values({ actionType, mode, locked: false, lockedReason: null, updatedAt: now, updatedBy: operatorId })
    .onConflictDoUpdate({ target: ringTrust.actionType, set: { mode, updatedAt: now, updatedBy: operatorId } })
  return { row: (await ledger(now)).find((r) => r.actionType === actionType)! }
}
