// Sim clock: Ringo's world starts at the dataset snapshot and runs forward.
// simNow = SNAPSHOT + (Date.now() - epoch) * RING_CLOCK_SPEED. The epoch lives
// in ring_meta so every process (Next, scripts, cron) shares one clock.
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { ringMeta } from "@/lib/ring-schema"

export const SNAPSHOT = "2026-10-21T09:00:00.000Z"
const SPEED = Number(process.env.RING_CLOCK_SPEED ?? 1) || 1

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
  return new Date(Date.parse(SNAPSHOT) + (Date.now() - (await epoch())) * SPEED).toISOString()
}

export async function resetClock(): Promise<void> {
  const value = Date.now()
  await db.insert(ringMeta).values({ key: "clock_epoch", value }).onConflictDoUpdate({ target: ringMeta.key, set: { value } })
  cached = { epoch: value, readAt: Date.now() }
}

export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
