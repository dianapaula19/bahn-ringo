"use client"

import { useEffect, useRef, useState } from "react"
import type { CallRecord, CallTurn, OrderStory, RunEvent, ToolName } from "@/lib/contract"
import { DESK, runRing } from "../../_lib/agent-api"
import { Icon } from "../icons"
import { FactChip, Simulated, When } from "./bits"
import { CallView } from "./story"

const DOING: Record<ToolName, string> = {
  read_order: "Reading the order", read_messages: "Reading messages and calls", read_docs: "Reading documents and site rules",
  record_fact: "Writing down what it learned", place_call: "Calling the site", call_input: "On the call",
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

export function RunPanel({ story, onDone }: { story: OrderStory; onDone: () => void }) {
  const [lines, setLines] = useState<Line[]>([])
  const [running, setRunning] = useState(false)
  const [offline, setOffline] = useState(false)
  const [message, setMessage] = useState("")
  const abort = useRef<AbortController | null>(null)
  const end = useRef<HTMLLIElement | null>(null)

  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }) }, [lines.length])

  async function start(trigger: "operator" | "replay", text?: string) {
    abort.current?.abort()
    const c = new AbortController(); abort.current = c
    setRunning(true); setOffline(false)
    setLines(text ? [{ kind: "you", text }] : [])
    try {
      await runRing(story.orderId, { trigger, message: text, operatorId: DESK }, (e) => {
        if (e.type === "error" && /offline/i.test(e.message)) setOffline(true)
        setLines((ls) => fold(ls, e))
      }, c.signal)
    } catch {
      setLines((ls) => [...ls, { kind: "text", text: "The connection to Ring was lost. Nothing is retried on its own; reload the order to see what was saved.", tone: "danger" }])
    }
    if (!c.signal.aborted) { setRunning(false); onDone() }
  }

  const last = [...story.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]

  if (!story.ringEligible) return <section className="ring-panel" aria-labelledby="ring-h">
    <div className="sec-head"><h2 id="ring-h">Ring</h2></div>
    <p className="empty">{story.ringIneligibleReason ?? "Ring does not work this kind of order."} Ring will not call or message anyone here.</p>
  </section>

  return <section className="ring-panel" aria-labelledby="ring-h">
    <div className="sec-head"><h2 id="ring-h">Ring</h2>
      <span className="note">Ring reads first, then rings the pickup site or asks the driver. It never contacts the customer.</span></div>
    <div className="ring-controls">
      <button type="button" className="btn primary" disabled={running} onClick={() => start("operator")}><Icon name="bot" size={15} /> {running ? "Ring is working…" : "Run Ring"}</button>
      <button type="button" className="btn" disabled={running} onClick={() => start("replay")}>Watch a recorded run</button>
      {running && <button type="button" className="btn" onClick={() => { abort.current?.abort(); setRunning(false); onDone() }}>Stop watching</button>}
    </div>
    <form className="ring-chat" onSubmit={(e) => { e.preventDefault(); const t = message.trim(); if (t && !running) { setMessage(""); start("operator", t) } }}>
      <label className="sr-only" htmlFor="ring-msg">Tell Ring something</label>
      <textarea id="ring-msg" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Tell Ring something, e.g. “call stock control again” or “don't call before 10:00”"
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} />
      <button type="submit" className="btn" disabled={running || !message.trim()}>Send</button>
    </form>

    {offline && <p className="result tone-warn" role="status">Ring is offline right now (no model key). You can still watch a recorded run. <button type="button" className="link-btn" onClick={() => start("replay")}>Replay</button></p>}
    {lines.length === 0 && !running && <p className="empty">{last ? <>Ring last ran <When at={last.startedAt} now={story.now} />{last.decision ? <>: {last.decision.headline}</> : null}</> : "Ring has not run on this order yet."}</p>}
    {lines.length === 0 && running && <ul className="steps" aria-busy="true"><li className="step-line pending"><span className="spin" />Starting…</li></ul>}
    {lines.length > 0 && <ul className="steps" aria-live="polite">
      {lines.map((l, i) => <li key={i} className={`step-line kind-${l.kind}`}><LineView line={l} now={story.now} live={running} /></li>)}
      <li ref={end} aria-hidden="true" />
    </ul>}
  </section>
}

function LineView({ line: l, now, live }: { line: Line; now: string; live: boolean }) {
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
    case "driver_message": return <p><Simulated>Simulated driver</Simulated> <b>{e.message.direction === "out" ? "Ring to driver:" : "Driver:"}</b> {e.message.body}</p>
    case "callback_scheduled": return <p><Icon name="waiting" size={14} />Will call back <When at={e.job.dueAt} now={now} />: {e.job.reason}</p>
    case "stop": return <div className="stop"><p className="stop-head">{e.decision.headline}</p>{e.decision.oneDecision && <p>{e.decision.oneDecision}</p>}</div>
    case "error": return <p className="tone-danger"><Icon name="alert" size={14} />{e.message}</p>
    default: return null
  }
}
