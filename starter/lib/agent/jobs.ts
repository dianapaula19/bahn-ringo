// Callback jobs and demo reset. The background script and the run-due route
// share runDue(), so cron and the "Try now" button do the same thing.
import { and, asc, eq, lte } from "drizzle-orm"
import { db } from "@/lib/db"
import type { CallbackJob, ResetResponse, RunDueResponse } from "@/lib/contract"
import { ringCalls, ringClaims, ringDriverMessages, ringEvents, ringFacts, ringJobs, ringMeta, ringPlaybooks, ringProposals, ringRuns, ringSteps, ringTrust, ringTurns, ringCorrections, ringLearnedRules } from "@/lib/ring-schema"
import { newId, resetClock, simNow } from "./clock"
import { liveRun, runRing } from "./loop"
import { toJob } from "./store"

export async function listJobs(): Promise<CallbackJob[]> {
  return (await db.select().from(ringJobs).orderBy(asc(ringJobs.dueAt))).map(toJob)
}

/** Fire every scheduled callback that is due. `wait` = await the runs (scripts); otherwise they continue in the background. */
export async function runDue(opts: { wait: boolean; force?: boolean } = { wait: false }): Promise<RunDueResponse> {
  const now = await simNow()
  const due = await db.select().from(ringJobs).where(opts.force ? eq(ringJobs.status, "scheduled") : and(eq(ringJobs.status, "scheduled"), lte(ringJobs.dueAt, now)))
  const fired: RunDueResponse["fired"] = []
  const runs: Promise<unknown>[] = []
  for (const job of due) {
    if (await liveRun(job.orderId)) continue
    const runId = newId("run")
    // Claim the job first so a second runner cannot fire it twice.
    const claimed = await db.update(ringJobs).set({ status: "done", firedRunId: runId }).where(and(eq(ringJobs.id, job.id), eq(ringJobs.status, "scheduled"))).returning()
    if (!claimed.length) continue
    fired.push({ jobId: job.id, runId, orderId: job.orderId })
    runs.push(runRing({ orderId: job.orderId, trigger: "callback", runId, message: `Scheduled callback (${job.reason}). Re-read before you dial.` }).catch(() => null))
  }
  if (opts.wait) await Promise.all(runs)
  return { now, fired }
}

export async function reset(): Promise<ResetResponse> {
  const tables = { ring_runs: ringRuns, ring_steps: ringSteps, ring_calls: ringCalls, ring_driver_messages: ringDriverMessages, ring_facts: ringFacts, ring_proposals: ringProposals, ring_events: ringEvents, ring_jobs: ringJobs, ring_trust: ringTrust, ring_meta: ringMeta, ring_playbooks: ringPlaybooks, ring_turns: ringTurns, ring_claims: ringClaims, ring_corrections: ringCorrections, ring_learned_rules: ringLearnedRules }
  const cleared: Record<string, number> = {}
  for (const [name, table] of Object.entries(tables)) cleared[name] = (await db.delete(table).returning()).length
  await resetClock()
  return { now: await simNow(), cleared }
}

/** Remove Ringo's rows for one order (eval and demo re-runs). The dataset is untouched. */
export async function clearOrder(orderId: string): Promise<void> {
  const runs = await db.select({ id: ringRuns.id }).from(ringRuns).where(eq(ringRuns.orderId, orderId))
  for (const r of runs) { await db.delete(ringSteps).where(eq(ringSteps.runId, r.id)); await db.delete(ringTurns).where(eq(ringTurns.runId, r.id)) }
  // Playbook notes learned on this order go too: their source calls are gone.
  for (const t of [ringRuns, ringCalls, ringDriverMessages, ringFacts, ringProposals, ringEvents, ringJobs, ringPlaybooks, ringClaims]) await db.delete(t).where(eq(t.orderId, orderId))
  for (const m of await db.select().from(ringMeta)) if ((m.value as { orderId?: string })?.orderId === orderId) await db.delete(ringMeta).where(eq(ringMeta.key, m.key))
}
