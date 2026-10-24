// Record Replay fixtures from Ringo's stored runs: for each order, all its runs
// (oldest first) become one stream in lib/agent/fixtures/<reference>.ndjson.
// Intermediate run_ended/run_started lines are dropped so a two-run story
// (drop → callback → reconciled call) replays as one stream.
//   npm run ring:record [-- ord-00516 ...]   (default: the five demo orders)
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { asc, eq } from "drizzle-orm"
import { db } from "../lib/db"
import type { RunEvent } from "../lib/contract"
import { ringRuns, ringSteps } from "../lib/ring-schema"

const DEMO = ["ord-00516", "ord-00458", "ord-00593", "ord-00010", "ord-00023"]

async function main() {
  const ids = process.argv.slice(2).filter((a) => a.startsWith("ord-"))
  for (const orderId of ids.length ? ids : DEMO) {
    const runs = (await db.select().from(ringRuns).where(eq(ringRuns.orderId, orderId)).orderBy(asc(ringRuns.startedAt))).filter((r) => r.status === "stopped")
    if (!runs.length) { console.log(`${orderId}: no finished run, skipped`); continue }
    const events: RunEvent[] = []
    for (const run of runs) events.push(...(await db.select().from(ringSteps).where(eq(ringSteps.runId, run.id)).orderBy(asc(ringSteps.seq))).map((s) => s.event as RunEvent))
    const firstStart = events.findIndex((e) => e.type === "run_started")
    const lastEnd = events.map((e) => e.type).lastIndexOf("run_ended")
    const stream = events.filter((e, i) => (e.type !== "run_started" || i === firstStart) && (e.type !== "run_ended" || i === lastEnd))
    const file = join("lib", "agent", "fixtures", `CD-42${orderId.slice(-4)}.ndjson`)
    writeFileSync(file, stream.map((e) => JSON.stringify(e)).join("\n") + "\n")
    console.log(`${orderId}: ${runs.length} run(s), ${stream.length} events → ${file}`)
  }
  await db.$client.end()
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
