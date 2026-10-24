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
  const refs = results.length ? await db.select({ id: orders.id, reference: orders.reference }).from(orders).where(inArray(orders.id, results.map((r) => r.orderId))) : []
  return { runs, latest, results, refs: new Map(refs.map((o) => [o.id, o.reference])), running: all[0]?.status === "running" ? all[0] : null, partial: all.length - runs.length, gate: await gateScore() }
}

export default async function EvalsPage() {
  const { runs, latest, results, refs, running, partial, gate } = await load()
  const history = runs.filter((r) => r.status === "done" && scored(r) > 0).reverse()
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
          <p className="tile-label">Pass rate, run by run</p>
          <Spark runs={history} />
          <p className="tile-hint">{history.length === 1 ? "One full run so far." : `Last ${history.length} full runs.`}{partial ? ` ${partial} partial ${partial === 1 ? "run" : "runs"} left out.` : ""}</p>
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
        {results.length === 0 ? <p className="empty">This run has no results.</p> : <ul className="ev-cards">{results.map((r) => <Card key={r.id} r={r} reference={refs.get(r.orderId) ?? r.orderId} />)}</ul>}
      </section>
    </>}

    <section className="sec ev-how" aria-labelledby="ev-how">
      <div className="sec-head"><h2 id="ev-how">How the checks work</h2></div>
      <p className="note-text">Every check is plain code over the run: which tools I used, what I said on the line, what I wrote down, what I proposed, how I stopped. No model grades another model. If the simulated side doesn&apos;t play its part, the scenario is marked &ldquo;didn&apos;t play out&rdquo; and left out of the score instead of counted as a pass. Calls, sites and drivers are simulated; nobody real is contacted.</p>
    </section>
  </main></AppFrame>
}

function Card({ r, reference }: { r: Result; reference: string }) {
  const v = VERDICT[r.verdict as keyof typeof VERDICT] ?? VERDICT.void
  const checks = r.checks as CheckRow[]
  const reasons = r.reasons as string[]
  return <li className={`ev-card ${r.verdict}`}>
    <div className="ev-card-head">
      <h3>{r.title}</h3>
      <span className={`chip ${v.tone}`}><span className="chip-dot" />{v.label}</span>
    </div>
    <p className="ev-meta">{r.scenarioId.startsWith("happy") ? "Everyday case" : "Red team"} · <Link className="ref-link" href={`/orders/${r.orderId}`}>{reference}</Link> · {Math.max(1, Math.round(r.durationMs / 1000))} s</p>
    <dl className="ev-pair">
      <div><dt>What I should do</dt><dd>{r.expected}</dd></div>
      <div><dt>What I did</dt><dd>{r.actual}</dd></div>
    </dl>
    {reasons.length > 0 && <ul className="ev-reasons">{reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
    <details className="ev-checks">
      <summary>{checks.filter((c) => c.ok).length} of {checks.length} checks held</summary>
      <ul>{checks.map((c) => <li key={c.label} className={c.ok ? "ok" : "bad"}><span aria-hidden="true">{c.ok ? "✓" : "✗"}</span><span className="sr-only">{c.ok ? "Held:" : "Missed:"}</span> {c.label}{c.setup ? <em> (the test itself)</em> : null}</li>)}</ul>
    </details>
  </li>
}

/** Pass rate over the scored scenarios of each run, oldest left. One series, one axis, 0 to 100 %. */
function Spark({ runs }: { runs: Run[] }) {
  if (!runs.length) return <p className="tile-hint">No finished runs yet.</p>
  const W = 220, H = 56, P = 6
  const x = (i: number) => (runs.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (runs.length - 1))
  const y = (rate: number) => H - P - rate * (H - 2 * P)
  const pts = runs.map((r, i) => ({ x: x(i), y: y(r.passed / scored(r)), r }))
  const last = runs[runs.length - 1]
  return <figure className="ev-spark">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Pass rate per run: ${runs.map((r) => `${r.passed} of ${scored(r)}`).join(", ")}`}>
      <line x1={P} x2={W - P} y1={y(1)} y2={y(1)} className="ev-grid" />
      <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} className="ev-grid" />
      {pts.length > 1 && <polyline points={pts.map((p) => `${p.x},${p.y}`).join(" ")} className="ev-line" />}
      {pts.map((p) => <g key={p.r.id} className="ev-pt">
        <circle cx={p.x} cy={p.y} r={10} className="ev-hit" />
        <circle cx={p.x} cy={p.y} r={4} className="ev-dot" />
        <title>{`${fmtDateTime(p.r.startedAt, ZONE)}: ${p.r.passed} of ${scored(p.r)} passed${p.r.note ? ` (${p.r.note})` : ""}`}</title>
      </g>)}
    </svg>
    <figcaption className="num">{Math.round((last.passed / scored(last)) * 100)} % now</figcaption>
  </figure>
}
