// "I'll handle it": who took an order off the shared queue, until when. Pure, client-safe.
// A claim holds until its recheck time, until the person hands it back, or until something new
// happens on the order (a message, an alert, a call, a run or a recorded change after the claim).
import type { Iso } from "@/lib/contract"

export type Claim = { id: string; orderId: string; by: string; note: string | null; at: Iso; recheckAt: Iso; releasedAt: Iso | null }
/** Queue rows and stories carry the order's active claim (null when nobody holds it). */
export type WithClaim = { claim?: Claim | null }

export const RECHECK_MINUTES = [15, 30, 60, 120] as const

export function activeClaim(claims: Claim[], latestActivityAt: Iso | null, now: Iso): Claim | null {
  const c = claims.filter((x) => !x.releasedAt).sort((x, y) => x.at.localeCompare(y.at)).pop()
  if (!c || c.recheckAt <= now) return null
  if (latestActivityAt && latestActivityAt > c.at) return null
  return c
}
