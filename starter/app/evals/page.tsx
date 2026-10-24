// How we test Ringo: the scenario suite's latest run (scripts/eval-suite.ts), its
// history, and the Reviewer gate's leave-one-out score. Linked from the trust page
// footer, not from the main navigation.
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import Link from "next/link"
import { desc, eq, inArray } from "drizzle-orm"
import type { EvalReport } from "@/lib/contract"
import { db } from "@/lib/db"
import { fmtDateTime } from "@/lib/present/time"
import { ringEvalResults, ringEvalRuns } from "@/lib/ring-schema"
import { orders } from "@/lib/schema"
import { AppFrame } from "../components/app-frame"
import { RingoFace } from "../components/ringo"
import "./evals.css"

export const dynamic = "force-dynamic"
export const metadata = { title: "How we test Ringo" }

type Run = typeof ringEvalRuns.$inferSelect
type Result = typeof ringEvalResults.$inferSelect
type CheckRow = { label: string; ok: boolean; setup?: boolean }

const ZONE = "Europe/Helsinki"
const VERDICT = {
  pass: { label: "Passed", tone: "tone-ok" },
  fail: { label: "Missed", tone: "tone-danger" },
  void: { label: "Didn't play out", tone: "tone-neutral" },
} as const
// Misses first, then the red team, then the everyday cases; alphabetical inside each so the order holds between runs.
const rank = (r: Result) => (r.verdict === "fail" ? 0 : r.verdict === "void" ? 1 : 2) * 2 + Number(r.scenarioId.startsWith("happy"))
const ORDER = (a: Result, b: Result) => rank(a) - rank(b) || a.title.localeCompare(b.title)
const scored = (r: Run) => r.passed + r.failed
const REPEAT = 3
type Repeat = { passed: number; runs: number; misses: string[] }

/** The latest leave-one-out report scripts/eval-reviewer.ts wrote (eval/gate-leave_one_out-*.json). */
async function gateScore(): Promise<EvalReport | null> {
  try {
    const dir = join(process.cwd(), "eval")
    const file = (await readdir(dir)).filter((f) => f.startsWith("gate-leave_one_out-")).sort().pop()
    return file ? (JSON.parse(await readFile(join(dir, file), "utf8")) as EvalReport) : null
  } catch { return null }
}

async function load() {
  const all = await db.select().from(ringEvalRuns).orderBy(desc(ringEvalRuns.startedAt)).limit(60)
  // Runs of a few scenarios (--only, a probe) would skew the history: the page shows full runs only.
  const size = (r: Run) => r.passed + r.failed + r.voided
  const full = Math.max(0, ...all.filter((r) => r.status === "done").map(size))
  const runs = all.filter((r) => r.status !== "done" || size(r) === full)
  const latest = runs.find((r) => r.status === "done") ?? null
  const results = latest ? (await db.select().from(ringEvalResults).where(eq(ringEvalResults.evalRunId, latest.id))).sort(ORDER) : []
  // A scenario re-run on its own (--only) after the latest full run: shown on its card, not in the score.
  const later = latest ? all.filter((r) => r.status === "done" && r.startedAt > latest.startedAt && size(r) < full) : []
  const rerun = new Map<string, { verdict: string; at: string; note: string | null }>()
  if (later.length) for (const x of (await db.select().from(ringEvalResults).where(inArray(ringEvalResults.evalRunId, later.map((r) => r.id)))).sort((a, b) => a.at.localeCompare(b.at)))
    rerun.set(x.scenarioId, { verdict: x.verdict, at: x.at, note: later.find((r) => r.id === x.evalRunId)?.note ?? null })
  // The same ten scenarios run again: k of n per scenario over the last REPEAT full runs, misses kept.
  const recent = runs.filter((r) => r.status === "done" && scored(r) > 0).slice(0, REPEAT)
  const repeat = new Map<string, Repeat>()
  if (recent.length) for (const x of await db.select().from(ringEvalResults).where(inArray(ringEvalResults.evalRunId, recent.map((r) => r.id)))) {
    if (x.verdict === "void") continue
    const k = repeat.get(x.scenarioId) ?? { passed: 0, runs: 0, misses: [] }
    k.runs++; if (x.verdict === "pass") k.passed++; else k.misses.push(...(x.reasons as string[]))
    repeat.set(x.scenarioId, k)
  }
  const refs = results.length ? await db.select({ id: orders.id, reference: orders.reference }).from(orders).where(inArray(orders.id, results.map((r) => r.orderId))) : []
  return { runs, latest, results, refs: new Map(refs.map((o) => [o.id, o.reference])), running: all[0]?.status === "running" ? all[0] : null, partial: all.length - runs.length, rerun, gate: await gateScore(), recent, repeat }
}

export default async function EvalsPage() {
  const { latest, results, refs, running, partial, rerun, gate, recent, repeat } = await load()
  const sum = recent.reduce((a, r) => ({ passed: a.passed + r.passed, scored: a.scored + scored(r) }), { passed: 0, scored: 0 })
  const steady = [...repeat.values()].filter((k) => k.passed === k.runs).length
  return <AppFrame><main className="page">
    <div className="trust-intro"><RingoFace size={64} /><div>
      <h1 className="page-title small">How we test Ringo</h1>
      <p className="intro">Ten situations, scripted like a test drive: simulated sites and drivers, the real me, the real rules. Each one is scored on what I actually did, not on what I said I did.</p>
    </div></div>

    {running && <p className="result" role="status">A test run started {fmtDateTime(running.startedAt, ZONE)} and is still going. The results below are from the one before.</p>}

    {!latest ? <section className="sec"><p className="empty">No test runs yet. Nobody has kicked the tyres. Run <span className="mono">npm run eval:suite</span> in the starter folder, then come back.</p></section> : <>
      <div className="tiles ev-tiles">
        <div className="tile">
          <p className="tile-label">Latest run</p>
          <p className="ev-big num">{latest.passed}<span> of {scored(latest)} passed</span></p>
          <p className="tile-hint">{fmtDateTime(latest.endedAt ?? latest.startedAt, ZONE)}{latest.voided ? ` · ${latest.voided} didn't play out, not counted` : ""}</p>
        </div>
        <div className="tile">
          <p className="tile-label">Same suite, run {recent.length === 1 ? "once" : `${recent.length} times`}</p>
          <p className="ev-big num">{sum.passed}<span> of {sum.scored} passed</span></p>
          <p className="tile-hint">{steady} of {repeat.size} scenarios passed every time. One run is one sample: the model can choose differently on the same case.{partial ? ` ${partial} partial ${partial === 1 ? "run" : "runs"} left out.` : ""}</p>
        </div>
        <div className="tile">
          <p className="tile-label">Reviewer gate, honest score</p>
          {gate ? <>
            <p className="ev-big num">{gate.passed}<span> of {gate.cases.length} past reviews</span></p>
            <p className="tile-hint">Each rule left out of the case it was learned from. Most come from one review, so this stays low until reviewers add cases.</p>
          </> : <p className="tile-hint">No gate score on file yet.</p>}
        </div>
      </div>

      <section className="sec" aria-labelledby="ev-results">
        <div className="sec-head"><h2 id="ev-results">Scenario by scenario</h2><span className="count num">{results.length}</span>
          <span className="note">{latest.note ? `${latest.note} · ` : ""}model {latest.model}</span></div>
        {results.length === 0 ? <p className="empty">This run has no results.</p> : <ul className="ev-cards">{results.map((r) => <Card key={r.id} r={r} reference={refs.get(r.orderId) ?? r.orderId} rerun={rerun.get(r.scenarioId)} repeat={recent.length > 1 ? repeat.get(r.scenarioId) : undefined} />)}</ul>}
      </section>
    </>}

    <section className="sec ev-how" aria-labelledby="ev-how">
      <div className="sec-head"><h2 id="ev-how">How the checks work</h2></div>
      <p className="note-text">Every check is plain code over the run: which tools I used, what I said on the line, what I wrote down, what I proposed, how I stopped. No model grades another model. If the simulated side doesn&apos;t play its part, the scenario is marked &ldquo;didn&apos;t play out&rdquo; and left out of the score instead of counted as a pass. Calls, sites and drivers are simulated; nobody real is contacted.</p>
    </section>
  </main></AppFrame>
}

function Card({ r, reference, rerun, repeat }: { r: Result; reference: string; rerun?: { verdict: string; at: string; note: string | null }; repeat?: Repeat }) {
  const v = VERDICT[r.verdict as keyof typeof VERDICT] ?? VERDICT.void
  const checks = r.checks as CheckRow[]
  const reasons = r.reasons as string[]
  return <li className={`ev-card ${r.verdict}`}>
    <div className="ev-card-head">
      <h3>{r.title}</h3>
      <span className={`chip ${v.tone}`}><span className="chip-dot" />{v.label}</span>
    </div>
    <p className="ev-meta">{r.scenarioId.startsWith("happy") ? "Everyday case" : "Red team"} · <Link className="ref-link" href={`/orders/${r.orderId}`}>{reference}</Link> · {Math.max(1, Math.round(r.durationMs / 1000))} s
      {repeat && <> · <b className={repeat.passed === repeat.runs ? "tone-ok" : "tone-danger"}>{repeat.passed} of {repeat.runs} runs passed</b></>}</p>
    {repeat && repeat.misses.length > 0 && r.verdict === "pass" && <p className="ev-rerun">Missed in {repeat.runs - repeat.passed} of the {repeat.runs} runs: {[...new Set(repeat.misses.map((m) => m.replace(/^Missed:\s*/, "")))].join(" ")}</p>}
    <dl className="ev-pair">
      <div><dt>What I should do</dt><dd>{r.expected}</dd></div>
      <div><dt>What I did</dt><dd>{r.actual}</dd></div>
    </dl>
    {reasons.length > 0 && <ul className="ev-reasons">{reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
    {rerun && <p className="ev-rerun">Run again on its own {fmtDateTime(rerun.at, ZONE)}: {(VERDICT[rerun.verdict as keyof typeof VERDICT] ?? VERDICT.void).label.toLowerCase()}{rerun.note ? ` (${rerun.note})` : ""}. Not in the score above.</p>}
    <details className="ev-checks">
      <summary>{checks.filter((c) => c.ok).length} of {checks.length} checks held</summary>
      <ul>{checks.map((c) => <li key={c.label} className={c.ok ? "ok" : "bad"}><span aria-hidden="true">{c.ok ? "✓" : "✗"}</span><span className="sr-only">{c.ok ? "Held:" : "Missed:"}</span> {c.label}{c.setup ? <em> (the test itself)</em> : null}</li>)}</ul>
    </details>
  </li>
}
