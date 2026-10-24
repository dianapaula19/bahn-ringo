// Demo seed (no model key needed): puts what the video shows into a fresh clone's database.
//   npm run demo:seed
// 1. The five recorded Ringo runs (lib/agent/fixtures/*.ndjson, written by scripts/ring-record.ts from real
//    runs) become ring rows: runs, steps, calls, driver messages, facts, proposals, callbacks. Each run is
//    stored with trigger "replay" and says where it came from. Proposals stay PENDING_REVIEW: approving or
//    rejecting them is the person's job, so no review, no learned rule and no correction is invented here.
// 2. The recorded scenario-suite runs in eval/suite-*.json go into ring_eval_runs/results, so /evals shows the
//    real results (misses included). Nothing is re-scored or edited.
// It clears Ringo's rows on those five orders first, and moves the sim clock to just after the last recorded
// step, so the runs read as "a few minutes ago". The dataset is untouched.
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { CallRecord, CallbackJob, DriverMessage, Fact, Proposal, RunEvent, StopDecision } from "../lib/contract"

type Seg = { runId: string; events: RunEvent[]; stop: StopDecision | null; startedAt: string; endedAt: string }
const at = (e: RunEvent): string | null => ("at" in e ? e.at : e.type === "call_ended" ? e.call.endedAt ?? e.call.startedAt : e.type === "fact" ? null : null)
const runIdOf = (e: RunEvent): string | null => e.type === "run_started" || e.type === "run_ended" ? e.runId
  : e.type === "call_ended" ? e.call.runId : e.type === "proposal" ? e.proposal.runId ?? null
    : e.type === "callback_scheduled" ? e.job.createdByRunId : e.type === "driver_message" ? e.message.runId : null

/** A fixture is one or more runs back to back (010: the first run, then the callback run). Split at each stop. */
function segments(events: RunEvent[]): Seg[] {
  const out: Seg[] = []
  let cur: RunEvent[] = []
  const close = () => {
    if (!cur.length) return
    const runId = cur.map(runIdOf).find((x): x is string => !!x && x !== "replay")
    const times = cur.map(at).filter((x): x is string => !!x).sort()
    const stop = cur.find((e) => e.type === "stop") as Extract<RunEvent, { type: "stop" }> | undefined
    if (runId) out.push({ runId, events: cur, stop: stop?.decision ?? null, startedAt: times[0], endedAt: stop?.at ?? times[times.length - 1] })
    cur = []
  }
  for (const e of events) {
    if (e.type === "run_ended" && !cur.length && out.length) { out[out.length - 1].events.push(e); continue }
    cur.push(e)
    if (e.type === "stop") close()
  }
  close()
  return out
}

async function main() {
  const { db } = await import("../lib/db")
  const S = await import("../lib/ring-schema")
  const { clearOrder } = await import("../lib/agent/jobs")
  const { SNAPSHOT, simNow } = await import("../lib/agent/clock")
  const { orders } = await import("../lib/schema")

  const dir = join(process.cwd(), "lib", "agent", "fixtures")
  const refs = new Map((await db.select({ id: orders.id, reference: orders.reference }).from(orders)).map((o) => [o.reference, o.id]))
  let latest = SNAPSHOT
  const counts = { runs: 0, steps: 0, calls: 0, driverMessages: 0, facts: 0, proposals: 0, callbacks: 0 }

  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".ndjson")).sort()) {
    const reference = file.replace(/\.ndjson$/, "")
    const orderId = refs.get(reference)
    if (!orderId) { console.log(`skip ${file}: no order ${reference} in this database`); continue }
    const events = (await readFile(join(dir, file), "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RunEvent)
    await clearOrder(orderId)
    const segs = segments(events)
    const model = (events.find((e) => e.type === "run_started") as Extract<RunEvent, { type: "run_started" }> | undefined)?.model ?? "recorded"
    const facts = new Map<string, Fact>(), props = new Map<string, Proposal>(), calls = new Map<string, CallRecord>()
    const dms = new Map<string, DriverMessage>(), jobs = new Map<string, CallbackJob>()
    const supersede: { old: string; by: string; level: "refuted" | "stale" }[] = []

    for (const [i, seg] of segs.entries()) {
      await db.insert(S.ringRuns).values({
        id: seg.runId, orderId, trigger: "replay", status: "stopped", model, decision: seg.stop, error: null,
        operatorMessage: `Recorded run loaded by npm run demo:seed (lib/agent/fixtures/${file}), not a live run.`, startedAt: seg.startedAt, endedAt: seg.endedAt,
      })
      await db.insert(S.ringSteps).values(seg.events.map((event, seq) => ({ runId: seg.runId, seq, event })))
      counts.runs++; counts.steps += seg.events.length
      // record_fact with supersedesFactId: the overturned fact is the one named; the new fact is the next fact event of that step.
      let pending: { old: string; effect: string } | null = null
      for (const e of seg.events) {
        if (e.type === "tool_call" && e.tool === "record_fact" && typeof e.input.supersedesFactId === "string") pending = { old: e.input.supersedesFactId, effect: String(e.input.effect ?? "replaces") }
        if (e.type === "tool_result" && e.tool === "record_fact") pending = null
        if (e.type === "fact") {
          facts.set(e.fact.id, { ...e.fact, runId: seg.runId } as Fact)
          if (pending) { supersede.push({ old: pending.old, by: e.fact.id, level: pending.effect === "refutes" ? "refuted" : "stale" }); pending = null }
        }
        if (e.type === "proposal") props.set(e.proposal.id, e.proposal)
        if (e.type === "call_ended") calls.set(e.call.id, e.call)
        if (e.type === "driver_message") dms.set(e.message.id, e.message)
        // A callback in a fixture was fired by the run after it (the next segment).
        if (e.type === "callback_scheduled") jobs.set(e.job.id, { ...e.job, status: segs[i + 1] ? "done" : e.job.status, firedRunId: segs[i + 1]?.runId ?? e.job.firedRunId })
      }
      if (seg.endedAt > latest) latest = seg.endedAt
    }
    for (const s of supersede) {
      const old = facts.get(s.old)
      if (old) facts.set(s.old, { ...old, level: s.level, supersededByFactId: s.by })
      else if (s.old.startsWith("ds:")) await db.insert(S.ringMeta).values({ key: `supersede:${s.old}`, value: { orderId, factId: s.by, level: s.level } }).onConflictDoNothing()
    }
    if (calls.size) await db.insert(S.ringCalls).values([...calls.values()].map((c) => ({ id: c.id, runId: c.runId, orderId, siteId: c.siteId, number: c.number, purpose: c.purpose, status: c.status, outcome: c.outcome, ivrPath: c.ivrPath, transcript: c.transcript, reconciledFrom: c.reconciledFrom, startedAt: c.startedAt, endedAt: c.endedAt })))
    if (dms.size) await db.insert(S.ringDriverMessages).values([...dms.values()].map((d) => ({ id: d.id, runId: d.runId, orderId, driverId: d.driverId, direction: d.direction, intent: d.intent, body: d.body, proposalId: d.proposalId, at: d.at })))
    if (facts.size) await db.insert(S.ringFacts).values([...facts.values()].map((f) => ({ id: f.id, orderId, runId: (f as Fact & { runId?: string }).runId ?? null, subject: f.subject, claim: f.claim, level: f.level, sourceKind: f.sourceKind, sourceId: f.sourceId, by: f.by, at: f.at, supersededByFactId: f.supersededByFactId, note: f.note })))
    if (props.size) await db.insert(S.ringProposals).values([...props.values()].map((p) => ({
      id: p.id, orderId, runId: p.runId!, command: p.command, actionType: p.actionType ?? p.command, targetType: p.targetType, targetId: p.targetId, alertId: p.alertId,
      proposedPayload: p.proposedPayload, rationale: p.rationale, summary: p.summary, evidenceRefs: p.evidenceRefs, dependency: p.dependency, status: p.status, review: null,
      execution: p.execution, supersededByProposalId: p.supersededByProposalId, onApprove: p.onApprove ?? "", onReject: p.onReject ?? "", gate: p.gate, trustMode: p.trustMode ?? "ask", createdAt: p.createdAt,
    })))
    if (jobs.size) await db.insert(S.ringJobs).values([...jobs.values()].map((j) => ({ id: j.id, orderId, dueAt: j.dueAt, reason: j.reason, status: j.status, createdByRunId: j.createdByRunId, firedRunId: j.firedRunId })))
    counts.calls += calls.size; counts.driverMessages += dms.size; counts.facts += facts.size; counts.proposals += props.size; counts.callbacks += jobs.size
    console.log(`${reference}: ${segs.length} run${segs.length === 1 ? "" : "s"}, ${calls.size} calls, ${facts.size} facts, ${props.size} proposals`)
  }

  // The sim clock: one minute after the last recorded step.
  const epoch = Date.now() - (Date.parse(latest) - Date.parse(SNAPSHOT)) - 60_000
  await db.insert(S.ringMeta).values({ key: "clock_epoch", value: epoch }).onConflictDoUpdate({ target: S.ringMeta.key, set: { value: epoch } })

  let evalRuns = 0
  for (const file of (await readdir(join(process.cwd(), "eval"))).filter((f) => /^suite-.*\.json$/.test(f)).sort()) {
    const j = JSON.parse(await readFile(join(process.cwd(), "eval", file), "utf8")) as { runs: (typeof S.ringEvalRuns.$inferInsert)[]; results: (typeof S.ringEvalResults.$inferInsert)[] }
    evalRuns += (await db.insert(S.ringEvalRuns).values(j.runs).onConflictDoNothing().returning()).length
    await db.insert(S.ringEvalResults).values(j.results).onConflictDoNothing()
  }
  console.log(`\nLoaded ${counts.runs} recorded runs (${counts.steps} steps, ${counts.calls} calls, ${counts.facts} facts, ${counts.proposals} proposals waiting for a person) and ${evalRuns} new scenario-suite runs.`)
  console.log(`Sim clock now ${await simNow()}. Approve or reject the proposals yourself on /decide.`)
  await db.$client.end()
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
