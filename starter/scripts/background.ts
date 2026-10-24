// Ring's background runner, no cron library.
//   npm run ring:background            one pass (what an external cron calls)
//   npm run ring:background -- --loop  stay up: triage every 5 min, due callbacks every minute
//   --autorun                          also start Ring on "Ring can call" orders it has never worked (max 2 per pass)
// A pass: triage every order (printed as a short summary), then fire due callbacks.
import type { Triage } from "../lib/contract"
import { runDue } from "../lib/agent/jobs"
import { liveRun, runRing } from "../lib/agent/loop"
import { simNow } from "../lib/agent/clock"
import { triageAll } from "../lib/agent/story"

const args = new Set(process.argv.slice(2))
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

async function triagePass() {
  const now = await simNow()
  const all = await triageAll(now)
  const by = (bucket: Triage["bucket"]) => all.filter((a) => a.triage.bucket === bucket)
  log(`triage at sim ${now}: needs you ${by("needs_you").length}, Ring ${by("ring").length}, waiting ${by("waiting").length}, quiet ${by("quiet").length}`)
  for (const { triage: t } of by("needs_you")) log(`  needs you  ${t.reference}  ${t.reason}  ${t.why}`)
  if (!args.has("--autorun")) return
  const fresh = by("ring").filter((a) => a.triage.reason === "RING_CAN_CALL" && a.ring.runs.length === 0).slice(0, 2)
  for (const { bundle } of fresh) {
    if (await liveRun(bundle.order.id)) continue
    const run = await runRing({ orderId: bundle.order.id, trigger: "triage" })
    log(`  Ring ran on ${bundle.order.reference}: ${run.decision?.outcome ?? run.status} ${run.decision?.headline ?? run.error ?? ""}`)
  }
}

async function duePass() {
  const due = await runDue({ wait: true })
  for (const f of due.fired) log(`  callback ${f.jobId} fired run ${f.runId} on ${f.orderId}`)
}

async function main() {
  await triagePass()
  await duePass()
  if (!args.has("--loop")) process.exit(0)
  let tick = 0
  setInterval(() => {
    tick++
    const work = tick % 5 === 0 ? triagePass().then(duePass) : duePass()
    work.catch((e) => log(`pass failed: ${e instanceof Error ? e.message : e}`))
  }, 60_000)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
