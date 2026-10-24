// Technical trace: per run, every model turn and tool call with wall-clock timing, tokens, model,
// gate decisions and errors. The engineering view (monospace allowed here only); not in the main nav.
// Reached from the run panel's "Technical trace" link. Reads ring_runs, ring_steps (wall_at) and ring_turns.
import "./engine.css"
import type { Metadata } from "next"
import Link from "next/link"
import { asc, desc, inArray } from "drizzle-orm"
import type { GateResult, RunEvent, StopDecision, ToolName } from "@/lib/contract"
import { db } from "@/lib/db"
import { fmtDateTime } from "@/lib/present/time"
import { ringRuns, ringSteps, ringTurns } from "@/lib/ring-schema"
import { orders } from "@/lib/schema"
import { AppFrame } from "../components/app-frame"
import { RingoFace } from "../components/ringo"
import { SavingsSection } from "../components/savings"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Technical trace" }

type Turn = typeof ringTurns.$inferSelect
type Row =
  | { kind: "model"; t: number; turn: Turn }
  | { kind: "tool"; t: number; tool: ToolName; input: Record<string, unknown>; ok: boolean | null; summary: string | null; ms: number | null; sims: Turn[] }
  | { kind: "gate"; t: number; command: string; result: GateResult }
  | { kind: "error"; t: number; message: string }
  | { kind: "stop"; t: number; decision: StopDecision }

const RUNS = 30
const ms = (v: string | null) => (v ? Date.parse(v) : NaN)
const num = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-GB")
const secs = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`)
const SIM: Partial<Record<ToolName, string>> = { place_call: "site sim", call_input: "site sim", send_driver_message: "driver sim" }

/** PostHog's app lives next to its ingestion host: eu.i.posthog.com → eu.posthog.com. */
function posthogApp(): { url: string | null; on: boolean } {
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim()
  const on = Boolean(host && process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim())
  if (!on || !/\.i\.posthog\.com\/?$/.test(host!)) return { url: null, on }
  return { url: `${host!.replace(/\/$/, "").replace(".i.posthog.com", ".posthog.com")}/llm-analytics/traces`, on }
}

/** One run's steps and model calls, in wall-clock order. Simulator replies nest under the tool that made them. */
function rowsFor(steps: { seq: number; event: unknown; wallAt: string | null }[], turns: Turn[]): Row[] {
  const rows: Row[] = []
  const tools = new Map<string, Extract<Row, { kind: "tool" }>>()
  const base = ms(steps.find((s) => s.wallAt)?.wallAt ?? null)
  let last = NaN
  for (const s of steps) {
    const e = s.event as RunEvent
    // Recorded runs have no wall clock: the event's own (sim) time keeps the gaps real; an event without one takes the last.
    const at = "at" in e ? ms(e.at) : NaN
    const t = Number.isFinite(ms(s.wallAt)) ? ms(s.wallAt) : Number.isFinite(at) ? at : Number.isFinite(last) ? last : (base || 0) + s.seq
    last = t
    if (e.type === "tool_call") { const r: Row = { kind: "tool", t, tool: e.tool, input: e.input, ok: null, summary: null, ms: null, sims: [] }; tools.set(e.stepId, r); rows.push(r) }
    else if (e.type === "tool_result") { const r = tools.get(e.stepId); if (r) { r.ok = e.ok; r.summary = e.summary; r.ms = t - r.t } }
    else if (e.type === "gate") rows.push({ kind: "gate", t, command: e.command, result: e.result })
    else if (e.type === "error") rows.push({ kind: "error", t, message: e.message })
    else if (e.type === "stop") rows.push({ kind: "stop", t, decision: e.decision })
  }
  const toolRows = [...tools.values()]
  for (const turn of turns) {
    const t = ms(turn.startedAt)
    const host = turn.name === "ringo_turn" ? null : toolRows.find((r) => t >= r.t && t <= r.t + (r.ms ?? Infinity))
    if (host) host.sims.push(turn)
    else rows.push({ kind: "model", t, turn })
  }
  return rows.sort((a, b) => a.t - b.t)
}

/** A refused step or a failure, in plain words: what happened, and its cause. Guards refusing a step is the system
 *  working (nothing changed); a model or run failure is not. ponytail: matches the guards' own messages; give the
 *  guards an error code if these start to drift. */
const REFUSED: [RegExp, string, string][] = [
  [/no live call with that id/i, "pressed a key on a call that had already ended",
    "The phone simulator only takes input on a live call. The call had ended before Ringo's next key press, so the simulator refused it. Nothing happened on the line and nothing on the order changed."],
  [/refutation must cite a source later/i, "tried to mark a claim untrue without a newer source",
    "The evidence check (hard rule 4) lets Ringo refute a claim only with a source recorded after the claim. The source he cited was not newer, so the fact was not written and the claim stayed as it was."],
  [/supports at most|is never allowed|verified/i, "rated a fact higher than its source allows",
    "The evidence ladder caps a fact's level by the kind of source behind it. Ringo asked for a higher level, so the fact was not written."],
  [/not a .+ row|unknown source|does not exist|must exist/i, "cited a record that does not exist or does not fit",
    "Every fact must cite a record that exists and is the kind it claims to be. This one was not, so it was dropped."],
  [/customer/i, "tried to contact a customer",
    "Ringo never contacts a customer (hard rule 1). The tool guard refused the step; nobody was contacted."],
  [/step limit/i, "ran out of steps", "A run has a fixed number of steps. Ringo reached it and was told to stop with a decision."],
]
type Problem = { what: string; why: string; at: number }
function explain(text: string, at: number): Problem {
  const hit = REFUSED.find(([re]) => re.test(text))
  return hit ? { what: hit[1], why: hit[2], at } : { what: "a step was refused", why: `The guard said: “${text}” Nothing on the order changed.`, at }
}
function problems(rows: Row[], turns: Turn[], runError: string | null): Problem[] {
  const out: Problem[] = []
  for (const r of rows) {
    if (r.kind === "tool" && r.ok === false) out.push(explain(r.summary ?? "", r.t))
    if (r.kind === "error") out.push({ what: "the run hit an error", why: r.message, at: r.t })
  }
  for (const t of turns) if (t.error) out.push({ what: "a model call failed", why: `The model did not answer this turn: ${t.error}. Ringo stops rather than guess.`, at: Date.parse(t.startedAt) })
  if (runError && !out.length) out.push({ what: "the run stopped on an error", why: runError, at: NaN })
  return out
}

type Props = { searchParams: Promise<{ run?: string | string[] }> }

export default async function EnginePage({ searchParams }: Props) {
  const asked = (await searchParams).run
  const openId = Array.isArray(asked) ? asked[0] : asked
  const runs = await db.select().from(ringRuns).orderBy(desc(ringRuns.startedAt)).limit(RUNS)
  const ids = runs.map((r) => r.id)
  const [steps, turns, refs] = ids.length ? await Promise.all([
    db.select().from(ringSteps).where(inArray(ringSteps.runId, ids)).orderBy(asc(ringSteps.seq)),
    db.select().from(ringTurns).where(inArray(ringTurns.runId, ids)).orderBy(asc(ringTurns.startedAt)),
    db.select({ id: orders.id, reference: orders.reference }).from(orders).where(inArray(orders.id, [...new Set(runs.map((r) => r.orderId))])),
  ]) : [[], [], []]
  const refOf = new Map(refs.map((o) => [o.id, o.reference]))
  const ph = posthogApp()

  return <AppFrame><main className="page engine-page">
    <div className="trust-intro"><RingoFace size={48} /><div>
      <h1 className="page-title small">Technical trace</h1>
      <p className="intro">Under the hood. Kick the tyres all you like, nothing here changes an order.</p>
    </div></div>
    <p className="note-text">Every model turn and tool call of Ringo's last {RUNS} runs, with timing, tokens and the reviewer check. Runs loaded by demo:seed are recordings: they keep their steps and timing but carry no token data. Watching a replay adds nothing here. Times are Helsinki time on the sim clock.</p>
    <p className="engine-ph">{ph.on
      ? <>PostHog LLM analytics is on: each model call is sent as <code>$ai_generation</code> and each tool call as <code>$ai_span</code>, with the run id as the session id (no prompt text). {ph.url ? <a href={ph.url} target="_blank" rel="noopener noreferrer">Open LLM analytics ↗</a> : "Open LLM analytics in your PostHog app."}</>
      : <>PostHog LLM analytics is off (no <code>NEXT_PUBLIC_POSTHOG_*</code> settings). Everything on this page comes from the local database.</>}</p>

    {runs.length === 0 ? <p className="empty engine-empty">Nothing on the books yet. Send me out on an order and every turn I take lands here.</p>
      : <ul className="engine-runs">{runs.map((run) => {
        const mine = turns.filter((t) => t.runId === run.id)
        const rows = rowsFor(steps.filter((s) => s.runId === run.id), mine)
        const decision = run.decision as StopDecision | null
        const tools = rows.filter((r) => r.kind === "tool")
        const blocked = rows.filter((r) => r.kind === "gate" && !r.result.passed).length
        const wrong = problems(rows, mine, run.error)
        const ringo = mine.filter((t) => t.name === "ringo_turn")
        const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") => mine.reduce((s, t) => s + (t[k] ?? 0), 0)
        // Start to stop, the same span as the order page's step strip (the first model turn included).
        const wall = run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : rows.length ? rows[rows.length - 1].t - rows[0].t : null
        return <li key={run.id} id={run.id}>
          <details className="engine-run" open={run.id === openId}>
            <summary>
              <span className="engine-ref">{refOf.get(run.orderId) ?? run.orderId}</span>
              <span className="engine-when">{fmtDateTime(run.startedAt, "Europe/Helsinki", false)}</span>
              <span className={`engine-status s-${decision?.outcome ?? run.status}`}>{run.status === "running" ? "running" : (decision?.outcome ?? run.status).replace(/_/g, " ")}</span>
              <span className="engine-stats">{mine.length ? <>{run.trigger} · {ringo.length} turns · {tools.length} tools · {num(sum("inputTokens"))} in / {num(sum("outputTokens"))} out</> : <>recorded run · no token data · {tools.length} tools</>} · {secs(wall)}{blocked ? ` · ${blocked} blocked` : ""}</span>
              {wrong.length > 0 && <span className="engine-problem">{wrong.length === 1 ? `Refused step: Ringo ${wrong[0].what}` : `${wrong.length} refused steps`} · see why</span>}
            </summary>
            <div className="engine-body">
              {wrong.length > 0 && <div className="engine-why"><p className="engine-why-head">What went wrong, in plain words</p>
                <ul>{wrong.map((w, i) => <li key={i}><details open={wrong.length === 1}><summary>Ringo {w.what}{Number.isFinite(w.at) && rows.length ? ` (at +${((w.at - rows[0].t) / 1000).toFixed(1)} s)` : ""}</summary><p>{w.why}</p></details></li>)}</ul></div>}
              <dl className="engine-meta mono">
                <div><dt>run</dt><dd>{run.id}</dd></div>
                <div><dt>model</dt><dd>{run.model}</dd></div>
                {mine.length ? <>
                  <div><dt>tokens</dt><dd>in {num(sum("inputTokens"))} · cache read {num(sum("cacheReadTokens"))} · cache write {num(sum("cacheWriteTokens"))} · out {num(sum("outputTokens"))}</dd></div>
                  <div><dt>model time</dt><dd>{secs(mine.reduce((s, t) => s + t.latencyMs, 0))} over {mine.length} calls ({ringo.length} Ringo, {mine.length - ringo.length} simulator)</dd></div>
                </> : <div><dt>tokens</dt><dd>recorded run, no token data: its model calls were not stored with it. Timing below is the recording&apos;s own.</dd></div>}
                {run.error && <div className="bad"><dt>error</dt><dd>{run.error}</dd></div>}
                {decision && <div><dt>stop</dt><dd>{decision.headline}</dd></div>}
              </dl>
              {rows.length === 0 ? <p className="engine-none">No steps recorded for this run.</p> : <ol className="engine-rows mono">
                {rows.map((r, i) => <RowView key={i} row={r} t0={rows[0].t} />)}
              </ol>}
            </div>
          </details>
        </li>
      })}</ul>}
    <div className="engine-savings"><SavingsSection edit={false} /></div>
  </main></AppFrame>
}

function Tokens({ t }: { t: Turn }) {
  return <>{num(t.inputTokens)} in{t.cacheReadTokens ? ` (+${num(t.cacheReadTokens)} cached)` : ""}{t.cacheWriteTokens ? ` (+${num(t.cacheWriteTokens)} written)` : ""} / {num(t.outputTokens)} out</>
}

function RowView({ row: r, t0 }: { row: Row; t0: number }) {
  const at = <span className="engine-t">+{((r.t - t0) / 1000).toFixed(1)}s</span>
  switch (r.kind) {
    case "model": return <li className={`engine-row k-model${r.turn.error ? " bad" : ""}`}>{at}<span className="engine-k">model</span>
      <span>{r.turn.model} · {secs(r.turn.latencyMs)} · <Tokens t={r.turn} /> · {r.turn.error ?? `stop ${r.turn.stopReason ?? "–"}${r.turn.toolUses ? ` · ${r.turn.toolUses} tool use${r.turn.toolUses > 1 ? "s" : ""}` : ""}`}</span></li>
    case "tool": return <li className={`engine-row k-tool${r.ok === false ? " bad" : ""}`}>{at}<span className="engine-k">tool</span>
      <details className="engine-tool"><summary><b>{r.tool}</b> · {secs(r.ms)} · {r.ok === null ? "no result" : r.ok ? "ok" : "refused"}{r.summary ? ` · ${r.summary}` : ""}</summary>
        <pre>{JSON.stringify(r.input, null, 2)}</pre></details>
      {r.sims.map((s) => <p key={s.id} className={`engine-sim${s.error ? " bad" : ""}`}>↳ model ({SIM[r.tool] ?? "simulator"}) · {secs(s.latencyMs)} · <Tokens t={s} />{s.error ? ` · ${s.error}` : ""}</p>)}</li>
    case "gate": return <li className={`engine-row k-gate${r.result.passed ? "" : " bad"}`}>{at}<span className="engine-k">gate</span>
      <span>{r.command} · {r.result.passed ? "passed" : "blocked"}{r.result.findings.length ? ` · ${r.result.findings.map((f) => `${f.ruleId} (${f.effect})`).join(", ")}` : " · no findings"}</span></li>
    case "error": return <li className="engine-row k-error bad">{at}<span className="engine-k">error</span><span>{r.message}</span></li>
    case "stop": return <li className="engine-row k-stop">{at}<span className="engine-k">stop</span><span>{r.decision.outcome.replace(/_/g, " ")} · {r.decision.headline}</span></li>
  }
}
