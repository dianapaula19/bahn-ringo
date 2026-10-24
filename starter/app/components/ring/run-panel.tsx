"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import posthog from "posthog-js"
import type { CallRecord, CallTurn, OrderStory, RunDetail, RunEvent, RunOutcome, RunSummary, ToolName } from "@/lib/contract"
import { fmtDateTime } from "@/lib/present/time"
import { DESK, loadRun, runRing } from "../../_lib/agent-api"
import { Icon } from "../icons"
import { withBase } from "@/lib/base"
import { RingoFace } from "../ringo"
import { FactChip, Simulated, When } from "./bits"
import { CallView } from "./call-view"
import { callRung, LADDER_STOP, RUNG_LABEL, RUNGS, type Rung } from "@/lib/agent/sim/calls"

const DOING: Record<ToolName | "read_playbook" | "note_playbook", string> = {
  read_playbook: "Reading the site's playbook", note_playbook: "Writing notes for next time",
  read_order: "Reading the order", read_messages: "Reading messages and calls", read_docs: "Reading documents and site rules",
  record_fact: "Writing down what he learned", place_call: "Calling the site", call_input: "On the call",
  send_driver_message: "Messaging the driver", propose_action: "Drafting a proposal", schedule_callback: "Scheduling a callback", stop_with_decision: "Wrapping up",
}

type Line =
  | { kind: "you"; text: string }
  | { kind: "step"; stepId: string; text: string; done: boolean; ok: boolean }
  | { kind: "text"; text: string; tone?: string }
  | { kind: "call"; callId: string; turns: CallTurn[]; record: CallRecord | null }
  | { kind: "event"; event: RunEvent }

/** Folds the stream into readable lines: a step per tool, one live box per call. */
function fold(lines: Line[], e: RunEvent): Line[] {
  switch (e.type) {
    case "tool_call":
      if (e.tool === "call_input" || e.tool === "record_fact") return lines
      return [...lines, { kind: "step", stepId: e.stepId, text: DOING[e.tool], done: false, ok: true }]
    case "tool_result": {
      if (e.tool === "call_input") return lines
      const i = lines.findIndex((l) => l.kind === "step" && l.stepId === e.stepId)
      const done: Line = { kind: "step", stepId: e.stepId, text: e.summary, done: true, ok: e.ok }
      if (i < 0) return e.tool === "record_fact" && e.ok ? lines : [...lines, done]
      return lines.map((l, j) => (j === i ? done : l))
    }
    case "call_turn": {
      const i = lines.findIndex((l) => l.kind === "call" && l.callId === e.callId)
      if (i < 0) return [...lines, { kind: "call", callId: e.callId, turns: [e.turn], record: null }]
      return lines.map((l, j) => (j === i && l.kind === "call" ? { ...l, turns: [...l.turns, e.turn] } : l))
    }
    case "call_ended": {
      const i = lines.findIndex((l) => l.kind === "call" && l.callId === e.call.id)
      const line: Line = { kind: "call", callId: e.call.id, turns: e.call.transcript, record: e.call }
      return i < 0 ? [...lines, line] : lines.map((l, j) => (j === i ? line : l))
    }
    case "progress": return [...lines, { kind: "text", text: e.text }]
    case "run_started": return e.replay ? [...lines, { kind: "text", text: "Replaying a recorded run.", tone: "muted" }] : lines
    case "run_ended": return lines
    default: return [...lines, { kind: "event", event: e }]
  }
}

/** `heroRun`: the hero above shows the page's one "Run Ringo" button, so this panel hides its own; each new
 *  `runRequest` (a counter the hero bumps) starts a run here. `onRunning` tells the hero while a run is live. */
export function RunPanel({ story, onDone, heroRun = false, runRequest = 0, onRunning }: {
  story: OrderStory; onDone: () => void; heroRun?: boolean; runRequest?: number; onRunning?: (running: boolean) => void
}) {
  const [lines, setLines] = useState<Line[]>([])
  const [running, setRunning] = useState(false)
  const [replaying, setReplaying] = useState(false)
  const [offline, setOffline] = useState(false)
  const [message, setMessage] = useState("")
  const [liveRunId, setLiveRunId] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const end = useRef<HTMLLIElement | null>(null)

  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => { onRunning?.(running) }, [running, onRunning])
  const panel = useRef<HTMLElement | null>(null)
  const asked = useRef(runRequest)
  useEffect(() => {
    if (runRequest === asked.current) return
    asked.current = runRequest
    panel.current?.scrollIntoView({ block: "start", behavior: "smooth" })
    if (!running) start("operator")
  })
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }) }, [lines.length])
  // Escape stops watching a run or replay (the run itself still finishes on the server).
  useEffect(() => {
    if (!running) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") stop() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  function stop() { posthog.capture("ring_run_stopped"); abort.current?.abort(); setRunning(false); onDone() }

  async function start(trigger: "operator" | "replay", text?: string) {
    posthog.capture("ring_run_started", { trigger })
    abort.current?.abort()
    const c = new AbortController(); abort.current = c
    setRunning(true); setReplaying(trigger === "replay"); setOffline(false)
    setLines(text ? [{ kind: "you", text }] : [])
    try {
      await runRing(story.orderId, { trigger, message: text, operatorId: DESK }, (e) => {
        if (e.type === "run_started" && !e.replay) setLiveRunId(e.runId)
        if (e.type === "error" && /offline/i.test(e.message)) { setOffline(true); return } // the offline note below says it once
        setLines((ls) => fold(ls, e))
      }, c.signal)
    } catch {
      setLines((ls) => [...ls, { kind: "text", text: "The connection to Ringo was lost. Nothing is retried on its own; reload the order to see what was saved.", tone: "danger" }])
    }
    if (!c.signal.aborted) { setRunning(false); onDone() }
  }

  const last = [...story.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  // A run started in another tab (or before a reload) is still going on the server; same 10-minute cutoff as liveRun().
  const busyElsewhere = !running && last?.status === "running" && Date.parse(story.now) - Date.parse(last.startedAt) < 10 * 60_000

  // Ringo can't act here: one quiet line, not a panel. "…: a person owns this." is already said on the decision card.
  if (!story.ringEligible) return <p className="ring-aside" id="ring-h">
    <RingoFace size={24} /><span><b>Ringo stands back here.</b> {(story.ringIneligibleReason ?? "Ringo does not work this kind of order.").replace(/: a person owns this\.?$/, ".")} No calls, no messages.</span>
  </p>

  // The live call: from "Calling the site…" until the call ends. The site's name comes from the dial summary.
  const callOpen = running && lines.some((l) => (l.kind === "step" && !l.done && l.text === DOING.place_call) || (l.kind === "call" && !l.record))
  const site = lines.flatMap((l) => l.kind === "step" ? [/^Dialled (.+?) \(/.exec(l.text)?.[1]] : []).filter(Boolean).at(-1) ?? "the site"
  // The run ended with something for a person to review.
  const proposed = !running && lines.some((l) => l.kind === "event" && l.event.type === "proposal")
  const ladderStop = lines.flatMap((l) => (l.kind === "step" && l.done && l.text.includes(LADDER_STOP) ? [l.text.slice(l.text.indexOf(LADDER_STOP) + LADDER_STOP.length).trim()] : [])).at(-1) ?? null
  const ladderCalls = lines.flatMap((l) => (l.kind === "call" ? [{ rung: callRung(l.turns), outcome: l.record?.outcome ?? null, live: !l.record }] : []))

  return <section className="ring-panel" aria-labelledby="ring-h" ref={panel}>
    <div className="sec-head"><RingoFace size={40} /><h2 id="ring-h">Ringo</h2>
      <span className="note">Reads first, then rings the site or asks the driver. Never the customer.</span></div>
    <div className="ring-controls">
      {!heroRun && <button type="button" className="btn primary" disabled={running || busyElsewhere} onClick={() => start("operator")}><Icon name="bot" size={15} /> {running && replaying ? "Replaying…" : running || busyElsewhere ? "Ringo is working…" : "Run Ringo"}</button>}
      <button type="button" className="btn" disabled={running} onClick={() => start("replay")}>{running && replaying ? "Replaying…" : "Watch a recorded run"}</button>
      {running && <button type="button" className="btn" onClick={stop}>Stop watching</button>}
    </div>
    <form className="ring-chat" onSubmit={(e) => { e.preventDefault(); const t = message.trim(); if (t && !running && !busyElsewhere) { setMessage(""); start("operator", t) } }}>
      <label className="sr-only" htmlFor="ring-msg">Tell Ringo something</label>
      <textarea id="ring-msg" rows={1} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Tell Ringo something, e.g. “call stock control again” or “don't call before 10:00”"
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } else if (e.key === "Escape" && !running) e.currentTarget.blur() }} />
      <button type="submit" className="btn" disabled={running || busyElsewhere || !message.trim()}>Send</button>
    </form>

    {offline && <p className="result tone-warn" role="status">Ringo is offline right now (no model key). You can still watch a recorded run. <button type="button" className="link-btn" onClick={() => start("replay")}>Replay</button></p>}
    {lines.length === 0 && busyElsewhere && <p className="empty" role="status">Ringo is working on this order now (started <When at={last.startedAt} now={story.now} />). Reload in a moment to see what he found.</p>}
    {lines.length === 0 && !running && !busyElsewhere && !offline && (last && last.status !== "running"
      ? <RunSteps key={last.id} runs={story.runs} now={story.now} />
      : !last && <p className="empty">Ringo has not run on this order yet.</p>)}
    {lines.length === 0 && running && <ul className="steps" aria-busy="true"><li className="step-line pending"><span className="spin" />Starting…</li></ul>}
    {lines.length > 0 && <ul className="steps" aria-live="polite">
      {lines.map((l, i) => <li key={i} className={`step-line kind-${l.kind}`}><LineView line={l} now={story.now} live={running} acted={lines.slice(0, i).some((x) => x.kind === "step" || x.kind === "call")} /></li>)}
      <li ref={end} aria-hidden="true" />
    </ul>}
    {(ladderCalls.some((c) => c.rung) || ladderStop) && <Ladder calls={ladderCalls} stop={ladderStop} ended={!running} />}
    {callOpen && <p className="ringo-ringing" role="status"><span className="ring-pulse"><RingoFace size={32} /></span>Ringo is ringing {site}…</p>}
    {!running && lines.length > 0 && liveRunId && <p className="note-text"><TraceLink runId={liveRunId} /></p>}
    {proposed && <p className="ringo-done" role="status"><span className="ringo-thumb" aria-hidden="true">{/* eslint-disable-next-line @next/next/no-img-element -- a static svg */}<img src={withBase("/ringo.svg")} alt="" /></span>Done. Over to you.</p>}
  </section>
}

const TRIED: Record<string, string> = { ANSWERED: "answered", NO_ANSWER: "no answer", VOICEMAIL: "voicemail", CLOSED: "closed", DROPPED_UNKNOWN: "line dropped" }

/** The escalation ladder for this run: which rung each call reached, the current one, and why Ringo stopped climbing. */
function Ladder({ calls, stop, ended }: { calls: { rung: Rung | null; outcome: string | null; live: boolean }[]; stop: string | null; ended: boolean }) {
  const last = calls.filter((c) => c.rung).at(-1)
  const why = stop ?? (ended && last ? (last.outcome === "ANSWERED" ? `someone at ${RUNG_LABEL[last.rung!].toLowerCase()} answered, so there was no need to climb.` : `${RUNG_LABEL[last.rung!].toLowerCase()}: ${TRIED[last.outcome ?? ""] ?? "no answer"}. Climbing further is a person's call.`) : null)
  return <div className="ladder" aria-label="Escalation ladder">
    <ol>{RUNGS.map((r) => {
      const mine = calls.filter((c) => c.rung === r)
      const now = mine.some((c) => c.live)
      const state = now ? "on the line" : mine.length ? mine.map((c) => TRIED[c.outcome ?? ""] ?? "tried").join(", ") : "not tried"
      return <li key={r} className={`rung${now ? " now" : mine.length ? " tried" : ""}${last?.rung === r ? " current" : ""}`} aria-current={last?.rung === r ? "step" : undefined}>
        <span className="rung-dot" aria-hidden="true" /><b>{RUNG_LABEL[r]}</b><small>{state}</small></li>
    })}</ol>
    {why && <p className="ladder-why"><b>{stop ? "Why I stopped climbing:" : "Where I stopped:"}</b> {why.replace(/^\w/, (c) => c.toUpperCase())}</p>}
  </div>
}

/** The engineering view of one live run (/engine): model turns, tokens, timing. Not shown on this page. */
const TraceLink = ({ runId }: { runId: string }) => <Link href={`/engine?run=${runId}#${runId}`} prefetch={false} className="foot-link">Technical trace</Link>

function LineView({ line: l, now, live, acted }: { line: Line; now: string; live: boolean; acted: boolean }) {
  if (l.kind === "you") return <p className="you"><b>You:</b> {l.text}</p>
  if (l.kind === "text") return <p className={l.tone ? `tone-${l.tone === "muted" ? "neutral" : l.tone}` : undefined}>{l.text}</p>
  if (l.kind === "step") return <p className={l.done ? (l.ok ? "" : "tone-warn") : "pending"}>{l.done ? <Icon name={l.ok ? "check" : "alert"} size={14} /> : <span className="spin" />}{l.done ? l.text : `${l.text}…`}</p>
  if (l.kind === "call") return <CallView call={l.record ?? { id: l.callId, transcript: l.turns, outcome: null }} now={now} live={live && !l.record} />
  const e = l.event
  switch (e.type) {
    case "fact": return <><p className="step-label">Wrote down</p><FactChip fact={e.fact} now={now} /></>
    case "gate": return <p className={e.result.passed ? "" : "tone-warn"}><Icon name={e.result.passed ? "check" : "alert"} size={14} />Reviewer check {e.result.passed ? "passed" : "blocked it"}
      {e.result.findings.length > 0 && <>: {e.result.findings.map((f) => f.message).join(" ")}</>}</p>
    case "proposal": return <p className="tone-accent"><Icon name="proposal" size={14} />Proposal ready for you: {e.proposal.summary}</p>
    case "driver_message": return <p><Simulated>Simulated driver</Simulated> <b>{e.message.direction === "out" ? "Ringo to driver:" : "Driver:"}</b> {e.message.body}</p>
    case "callback_scheduled": return <p><Icon name="waiting" size={14} />Will call back <When at={e.job.dueAt} now={now} />: {e.job.reason}</p>
    case "stop": return e.decision.outcome === "failed" ? null : <div className="stop"><p className="stop-head">{e.decision.headline}</p>{e.decision.oneDecision && <p>{e.decision.oneDecision}</p>}</div>
    case "error": {
      // A failed live run says so once, in plain words; the model's own error text stays folded away.
      const tech = e.message.startsWith("Ringo stopped: ") ? e.message.slice(15) : null
      if (!tech) return <p className="tone-danger"><Icon name="alert" size={14} />{e.message}</p>
      return <div className="run-failed"><p className="tone-danger"><Icon name="alert" size={14} />
        {tech.startsWith("Model error") ? "Ringo couldn't reach his model." : "Ringo hit a problem and stopped."} {acted ? "What he did before that is listed above." : "Nothing changed."} Try again or work it by hand.</p>
        <details className="more"><summary><Icon name="chevron" size={12} />Technical details</summary><p className="tech">{tech}</p></details></div>
    }
    default: return null
  }
}

// ---------------------------------------------------------------- what the last run cost, step by step

type Step = { label: string; ms: number; sim?: boolean; tone?: "warn" }
const READ: Partial<Record<ToolName, string>> = { read_order: "Read order", read_messages: "Messages", read_docs: "Site rules", read_playbook: "Playbook" }
const STOPPED: Record<RunOutcome, string> = { proposal_ready: "Stop: proposal", needs_person: "Stop: you decide", waiting: "Stop: calls back", done: "Done", failed: "Stopped: failed" }
const CALL_OUT: Record<string, string> = { NO_ANSWER: "no answer", VOICEMAIL: "voicemail", CLOSED: "closed", DROPPED_UNKNOWN: "dropped" }

/** One run as its steps: cheap reads first, then the call, then the stop. Each step is timed from its own tool call to
 *  its result (a call from dialling to hang-up), so a read shows "<1 s". The time Ringo spends thinking between steps
 *  is said once, in the header, not charged to the step after it. Facts and playbook notes written between steps fold
 *  into one "Wrote" step. */
export function runSteps(events: RunEvent[], span?: { startedAt: string; endedAt: string | null }): { steps: Step[]; total: number; thinking: number } {
  const out: Step[] = []
  const t = (e: RunEvent) => ("at" in e ? Date.parse(e.at) : e.type === "call_ended" ? Date.parse(e.call.endedAt ?? e.call.startedAt) : NaN)
  const started = new Map<string, number>()
  let dialled = NaN
  let wrote = { facts: 0, notes: 0, ms: 0 }
  const flush = () => {
    if (wrote.facts || wrote.notes) out.push({ label: `Wrote ${[wrote.facts && `${wrote.facts} ${wrote.facts === 1 ? "fact" : "facts"}`, wrote.notes && "notes"].filter(Boolean).join(" + ")}`, ms: wrote.ms })
    wrote = { facts: 0, notes: 0, ms: 0 }
  }
  const push = (s: Step) => { flush(); out.push(s) }
  const took = (e: Extract<RunEvent, { type: "tool_result" }>) => Math.max(0, t(e) - (started.get(e.stepId) ?? t(e)))
  for (const e of events) {
    if (e.type === "tool_call") { started.set(e.stepId, t(e)); if (e.tool === "place_call") dialled = t(e) }
    else if (e.type === "tool_result" && READ[e.tool]) push({ label: READ[e.tool]!, ms: took(e) })
    else if (e.type === "tool_result" && e.tool === "record_fact" && e.ok) { wrote.facts++; wrote.ms += took(e) }
    else if (e.type === "tool_result" && e.tool === "note_playbook" && e.ok) { wrote.notes++; wrote.ms += took(e) }
    else if (e.type === "call_ended") {
      const rung = callRung(e.call.transcript)
      const how = CALL_OUT[e.call.outcome ?? ""]
      push({ label: `Call ${rung ? RUNG_LABEL[rung].toLowerCase() : "the site"}${how ? ` (${how})` : ""}`, ms: Number.isFinite(dialled) ? t(e) - dialled : NaN, sim: true, tone: how ? "warn" : undefined })
    } else if (e.type === "tool_result" && e.tool === "send_driver_message" && e.ok) push({ label: "Message driver", ms: took(e), sim: true })
    else if (e.type === "tool_result" && e.tool === "schedule_callback" && e.ok) push({ label: "Book callback", ms: took(e) })
    else if (e.type === "stop") push({ label: STOPPED[e.decision.outcome], ms: NaN })
  }
  flush()
  const times = events.map(t).filter(Number.isFinite)
  const total = times.length ? Math.max(...times) - Math.min(...times) : 0
  const whole = span?.endedAt ? Date.parse(span.endedAt) - Date.parse(span.startedAt) : NaN
  if (Number.isFinite(whole) && whole > total) return finish(out, whole)
  return finish(out, total)
}

function finish(out: Step[], total: number) {
  const spent = out.reduce((n, s) => n + (Number.isFinite(s.ms) ? s.ms : 0), 0)
  return { steps: out, total, thinking: Math.max(0, total - spent) }
}

const dur = (ms: number) => !Number.isFinite(ms) ? "" : ms < 1000 ? "<1 s" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
const OUTCOME: Record<RunOutcome, string> = { proposal_ready: "proposal", needs_person: "a person decides", waiting: "calls back", done: "done", failed: "failed" }

/** Ringo's runs on this order, newest first; the strip shows one, and earlier ones can be picked. */
function RunSteps({ runs, now }: { runs: RunSummary[]; now: string }) {
  const list = [...runs].filter((r) => r.status !== "running").sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const [runId, setRunId] = useState(list[0]?.id)
  const run = list.find((r) => r.id === runId) ?? list[0]
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!run) return
    setDetail(null); setError(false)
    const c = new AbortController()
    loadRun(run.id, c.signal).then(setDetail).catch(() => { if (!c.signal.aborted) setError(true) })
    return () => c.abort()
  }, [run?.id]) // eslint-disable-line react-hooks/exhaustive-deps -- refetch only when another run is picked
  if (!run) return null
  const { steps, total, thinking } = detail ? runSteps(detail.events, detail.run) : { steps: [], total: 0, thinking: 0 }
  const lead = <>{run === list[0] ? "Ringo last ran" : "Ringo ran"} <When at={run.startedAt} now={now} />{run.trigger === "replay" && " (a recorded run)"}</>
  const head = <div className="run-steps-head">
    <p>{lead}{steps.length > 0 && <> · {steps.some((x) => x.sim) ? "cheap work first, then the call, then stop" : "read first; no call needed, so he stopped"} · {dur(total)} in all{thinking >= 1000 && <>, {dur(thinking)} of it thinking between steps</>}</>} · <TraceLink runId={run.id} /></p>
    {list.length > 1 && <label className="run-pick"><span>Run</span><select value={run.id} onChange={(e) => setRunId(e.target.value)}>
      {list.map((r, i) => <option key={r.id} value={r.id}>{i === 0 ? "Latest" : `Earlier ${i}`}: {fmtDateTime(r.startedAt, null, false)}{r.decision ? ` · ${OUTCOME[r.decision.outcome]}` : ""}</option>)}</select></label>}
  </div>
  if (error || (detail && !steps.length)) return <div className="run-steps-wrap">{head}{error && <p className="empty">Could not load the steps of that run.</p>}</div>
  if (!detail) return <div className="run-steps-wrap">{head}<ol className="run-steps" aria-busy="true" aria-label="Loading the run's steps"><li className="run-step skel" /><li className="run-step skel" /><li className="run-step skel" /></ol></div>
  return <div className="run-steps-wrap">
    {head}
    <ol className="run-steps" aria-label="What Ringo's run did, step by step">{steps.map((s, i) => <li key={i} className={`run-step${s.tone ? ` tone-${s.tone}` : ""}${i === steps.length - 1 ? " last" : ""}`}>
      <b>{s.label}</b>{(dur(s.ms) || s.sim) && <small>{dur(s.ms)}{s.sim && <>{dur(s.ms) && " · "}<Simulated>sim</Simulated></>}</small>}
    </li>)}</ol>
  </div>
}
