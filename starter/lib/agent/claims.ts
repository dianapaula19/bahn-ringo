// A person's own decisions on an order that Ringo did not propose: "I'll handle it" (ring_claims) and the
// customer's roadside-or-tow choice on a safety card (a ring_events row, actor = the desk). Neither contacts
// anyone or books anything; booking the recovery stays a separate, approved cost.
import { and, eq, isNull } from "drizzle-orm"
import { db } from "@/lib/db"
import type { Desk } from "@/lib/contract"
import { loadOrder } from "@/lib/present/load"
import { rows, type Bundle } from "@/lib/present/bundle"
import { ringClaims, ringEvents } from "@/lib/ring-schema"
import { RECHECK_MINUTES, type Claim } from "@/lib/triage/claim"
import { RECOVERY_THEN } from "@/lib/triage/triage"
import { personStep, stayLine, type Names } from "@/lib/triage/follow-up"
import { newId, simNow } from "./clock"

const DESKS = new Set(["ops-support", "ops-readiness", "ops-planning", "ops-dispatch", "ops-import", "ops-travel", "ops-shift", "ops-intake", "ops-evidence", "ops-finance", "ops-expenses"])
type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

export async function claimOrder(orderId: string, body: { by?: string; note?: string | null; minutes?: number }): Promise<Result<Claim>> {
  if (!body.by || !DESKS.has(body.by)) return { ok: false, status: 400, error: "Say which desk takes it (by)." }
  const minutes = body.minutes ?? 30
  if (!(RECHECK_MINUTES as readonly number[]).includes(minutes)) return { ok: false, status: 400, error: `Back in ${RECHECK_MINUTES.join(", ")} minutes only.` }
  const note = body.note?.trim().slice(0, 140) || null
  if (!(await loadOrder(orderId))) return { ok: false, status: 404, error: "Order not found." }
  const now = await simNow()
  // One holder at a time: a new claim replaces the open one.
  await db.update(ringClaims).set({ releasedAt: now }).where(and(eq(ringClaims.orderId, orderId), isNull(ringClaims.releasedAt)))
  const claim: Claim = { id: newId("claim"), orderId, by: body.by, note, at: now, recheckAt: new Date(Date.parse(now) + minutes * 60_000).toISOString(), releasedAt: null }
  await db.insert(ringClaims).values(claim)
  return { ok: true, value: claim }
}

export async function releaseClaim(orderId: string): Promise<void> {
  await db.update(ringClaims).set({ releasedAt: await simNow() }).where(and(eq(ringClaims.orderId, orderId), isNull(ringClaims.releasedAt)))
}

/** The customer's choice on a safety card, as told to a person. Recorded, not acted on: the hero's next step becomes booking it. */
export async function recordRecoveryChoice(orderId: string, body: { choice?: string; note?: string; operatorId?: string }): Promise<Result<{ eventId: string; then: string }>> {
  if (!body.choice || !RECOVERY_THEN[body.choice]) return { ok: false, status: 400, error: "Choose roadside or tow." }
  if (!body.note?.trim()) return { ok: false, status: 400, error: "Say how you know (who you spoke to, when)." }
  if (!body.operatorId || !DESKS.has(body.operatorId)) return { ok: false, status: 400, error: "Say which desk records it (operatorId)." }
  const loaded = await loadOrder(orderId)
  if (!loaded) return { ok: false, status: 404, error: "Order not found." }
  const incident = rows(loaded.bundle, "incidents").find((i) => i.details.kind === "VEHICLE_WARNING" && !i.details.resolved_at)
  if (!incident) return { ok: false, status: 409, error: "This order has no open vehicle warning to decide on." }
  const eventId = newId("revt")
  await db.insert(ringEvents).values({
    id: eventId, orderId, at: await simNow(), command: "recovery.choice", actorType: "operator", actorId: body.operatorId as Desk, proposalId: null,
    changes: { choice: body.choice, note: body.note.trim().slice(0, 280), simulated: true }, sourceRefs: [{ table: "incidents", id: incident.id }],
  })
  return { ok: true, value: { eventId, then: recoveryThen(body.choice, followUpNames(loaded.bundle)) } }
}

/** "Then: you book the tow (it needs approval as a cost) and tell Kasper Kovelund who is coming · owner: … · it stays in Now
 *  until the recovery is booked". A safety card never leaves Now, so there is no "back at" time. */
export function recoveryThen(choice: string, names: Names = {}): string {
  return stayLine(personStep(RECOVERY_THEN[choice], names) ?? "book the recovery", "until the recovery is booked")
}

/** The names a "Then:" line uses for "the customer" and "the driver". */
export function followUpNames(b: Bundle): Names {
  const driverId = rows(b, "work_assignments").find((a) => a.details.status !== "CANCELLED")?.details.driver_id
  return { customer: b.customer.name, driver: typeof driverId === "string" ? b.dir.driverName(driverId) : null }
}
