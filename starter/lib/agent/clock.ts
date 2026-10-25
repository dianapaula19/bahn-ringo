// Sim clock: Ringo's world starts at the dataset snapshot and runs forward.
// simNow = SNAPSHOT + (Date.now() - epoch) * RING_CLOCK_SPEED. The epoch lives
// in ring_meta so every process (Next, scripts, cron) shares one clock.
// RING_CLOCK_SPEED=0 freezes the desk at FROZEN (12:09 Helsinki, just after the recorded demo runs), so a demo
// opened hours after `npm run demo:seed` reads the same as right after it, instead of every row turning overdue.
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { ringMeta } from "@/lib/ring-schema"

export const SNAPSHOT = "2026-10-21T09:00:00.000Z"
export const FROZEN = "2026-10-21T09:09:00.000Z"
const raw = Number(process.env.RING_CLOCK_SPEED ?? 1)
/** 0 = frozen at FROZEN; any other number scales real time (default 1). */
export const CLOCK_SPEED = Number.isFinite(raw) && raw >= 0 ? raw : 1

let cached: { epoch: number; readAt: number } | null = null

async function epoch(): Promise<number> {
  if (cached && Date.now() - cached.readAt < 2000) return cached.epoch
  const [row] = await db.select().from(ringMeta).where(eq(ringMeta.key, "clock_epoch"))
  let value = typeof row?.value === "number" ? row.value : null
  if (value === null) {
    value = Date.now()
    await db.insert(ringMeta).values({ key: "clock_epoch", value }).onConflictDoNothing()
  }
  cached = { epoch: value, readAt: Date.now() }
  return value
}

export async function simNow(): Promise<string> {
  if (CLOCK_SPEED === 0) return FROZEN
  return new Date(Date.parse(SNAPSHOT) + (Date.now() - (await epoch())) * CLOCK_SPEED).toISOString()
}

/** Restart the clock so simNow() reads `at` right now (default: the snapshot) and runs forward from there. */
export async function resetClock(at: string = SNAPSHOT): Promise<void> {
  const value = Date.now() - (Date.parse(at) - Date.parse(SNAPSHOT)) / (CLOCK_SPEED || 1)
  await db.insert(ringMeta).values({ key: "clock_epoch", value }).onConflictDoUpdate({ target: ringMeta.key, set: { value } })
  cached = { epoch: value, readAt: Date.now() }
}

export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
