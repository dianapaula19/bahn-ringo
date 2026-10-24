"use client"

import { useEffect, useState } from "react"
import posthog from "posthog-js"
import type { CallRecord, Fact, OrderStory, Proposal, ReviewDecision, ReviewResponse, StoryEntry } from "@/lib/contract"
import { DESK, reviewProposal } from "../../_lib/agent-api"
import { Icon } from "../icons"
import { ACTION, FactChip, MODE, Simulated, When } from "./bits"

// ---------------------------------------------------------------- plain-words payloads

const human = (key: string) => key.replace(/[_.]/g, " ").replace(/^\w/, (c) => c.toUpperCase())

export function plain(v: unknown): string {
  if (v === null || v === undefined || v === "") return "Not set"
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (Array.isArray(v)) return v.map(plain).join(", ") || "None"
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${human(k)}: ${plain(x)}`).join("; ")
  return String(v)
}

function Payload({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload)
  if (!entries.length) return null
  return <dl className="payload">{entries.map(([k, v]) => <div key={k}><dt>{human(k)}</dt><dd>{plain(v)}</dd></div>)}</dl>
}

// ---------------------------------------------------------------- the one decision

export function DecisionPanel({ story, onChanged }: { story: OrderStory; onChanged: () => void }) {
  const { triage, decision } = story
  const pending = story.proposals.filter((p) => p.status === "PENDING_REVIEW")
  const ask = decision?.oneDecision ?? triage.oneDecision
  const tone = triage.bucket === "needs_you" ? (triage.severity === "critical" ? "danger" : "warn") : triage.bucket === "ring" ? "accent" : "ok"
  return <section className={`decision d-${tone}`} aria-labelledby="decision-h">
    <p className="decision-label" id="decision-h">{ask ? "The decision" : triage.bucket === "needs_you" ? "Why this needs you" : "Where this stands"}</p>
    <p className="decision-text">{ask ?? triage.why}</p>
    {ask && <p className="decision-why">{decision?.headline ?? triage.why}</p>}
    {!story.ringEligible && story.ringIneligibleReason && <p className="decision-note"><Icon name="note" size={14} /> Not a Ringo order. {story.ringIneligibleReason}</p>}
    {triage.overtaken.length > 0 && <ul className="overtaken">{triage.overtaken.map((o) => <li key={o.ref.id}><s>{o.label}</s> overtaken by a later signal at <When at={o.overtakenAt} now={story.now} /></li>)}</ul>}
    {decision && (decision.did.length > 0 || decision.whatNext) && <div className="decision-did">
      {decision.did.length > 0 && <><p className="sub">What Ringo did</p><ul>{decision.did.map((d, i) => <li key={i}>{d}</li>)}</ul></>}
      {decision.whatNext && <p className="decision-next"><b>Next:</b> {decision.whatNext}</p>}
    </div>}
    {pending.map((p) => <ProposalCard key={p.id} proposal={p} story={story} onChanged={onChanged} />)}
    {!ask && pending.length === 0 && triage.bucket !== "needs_you" && <p className="decision-next">No decision is waiting on you.</p>}
  </section>
}

export function ProposalCard({ proposal: p, story, onChanged }: { proposal: Proposal; story: OrderStory; onChanged: () => void }) {
  const [mode, setMode] = useState<"idle" | "edit" | "reject">("idle")
  const [note, setNote] = useState("")
  const [draft, setDraft] = useState<Record<string, unknown>>(p.proposedPayload)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ text: string; tone: string } | null>(null)
  const readOnly = p.origin === "dataset"
  const blocks = p.gate?.findings.filter((f) => f.effect === "block") ?? []
  const conditions = p.gate?.findings.filter((f) => f.effect === "condition") ?? []

  async function send(decision: ReviewDecision) {
    if (decision !== "APPROVED" && !note.trim()) return
    setBusy(true)
    const r: ReviewResponse = await reviewProposal(p.id, { decision, note: note.trim() || null, finalPayload: decision === "EDITED" ? draft : undefined, reviewerId: DESK })
    setBusy(false)
    if ("error" in r) { setResult({ text: r.error, tone: "danger" }); return }
    if (r.execution?.status === "STALE") setResult({ text: "The order changed after Ringo wrote this, so nothing was changed. Run Ringo again so it re-reads first.", tone: "warn" })
    else if (r.execution?.status === "FAILED") setResult({ text: `It did not go through: ${r.execution.error ?? "unknown error"}. Check before trying again.`, tone: "danger" })
    else setResult({ text: r.next, tone: "ok" })
    posthog.capture("proposal_reviewed", {
      action_type: p.actionType,
      decision,
      origin: p.origin,
    })
    setMode("idle"); onChanged()
  }

  return <article className="proposal-card">
    <div className="proposal-card-head">
      <span className="chip tone-accent">{p.actionType ? ACTION[p.actionType] : "Recorded proposal"}</span>
      {p.trustMode && <span className={`chip tone-${MODE[p.trustMode].tone}`}>{MODE[p.trustMode].label}</span>}
      <span className="proposal-when">Proposed <When at={p.createdAt} now={story.now} /></span>
    </div>
    <p className="proposal-card-summary">{p.summary}</p>
    <p className="proposal-text">{p.rationale}</p>
    {mode !== "edit" && <Payload payload={p.proposedPayload} />}
    {(p.onApprove || p.onReject) && <dl className="payload consequences">
      {p.onApprove && <div><dt>If you accept</dt><dd>{p.onApprove}</dd></div>}
      {p.onReject && <div><dt>If you reject</dt><dd>{p.onReject}</dd></div>}
    </dl>}
    {blocks.length > 0 && <ul className="gate-list tone-danger">{blocks.map((f) => <li key={f.ruleId}><b>Blocked by the reviewer check:</b> {f.message}</li>)}</ul>}
    {conditions.length > 0 && <ul className="gate-list">{conditions.map((f) => <li key={f.ruleId}><b>Keep in mind:</b> {f.message}</li>)}</ul>}

    {mode === "edit" && <div className="edit-fields">{Object.entries(draft).map(([k, v]) => <label key={k} className="field">
      <span>{human(k)}</span>
      {typeof v === "boolean" ? <span className="check"><input type="checkbox" checked={v} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} /> Yes</span>
        : typeof v === "number" ? <input type="number" value={v} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} />
        : typeof v === "string" || v === null ? <input value={v ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
        : <span className="field-fixed">{plain(v)}</span>}
    </label>)}</div>}
    {mode !== "idle" && <label className="field">
      <span>{mode === "reject" ? "Why are you rejecting it? (required)" : "What did you change and why? (required)"}</span>
      <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
    </label>}

    {readOnly ? <p className="proposal-foot">Recorded before Ringo. Shown for context with the reviewer check's opinion; it cannot be reviewed here.</p>
      : <div className="actions">
        {mode === "idle" && <>
          <button type="button" className="btn primary" disabled={busy || blocks.length > 0} onClick={() => send("APPROVED")}>Accept</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setMode("edit")}>Edit</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setMode("reject")}>Reject</button>
        </>}
        {mode === "edit" && <><button type="button" className="btn primary" disabled={busy || !note.trim()} onClick={() => send("EDITED")}>Accept with my changes</button><button type="button" className="btn" onClick={() => { setMode("idle"); setDraft(p.proposedPayload); setNote("") }}>Cancel</button></>}
        {mode === "reject" && <><button type="button" className="btn danger" disabled={busy || !note.trim()} onClick={() => send("REJECTED")}>Reject</button><button type="button" className="btn" onClick={() => { setMode("idle"); setNote("") }}>Cancel</button></>}
      </div>}
    {result && <p className={`result tone-${result.tone}`} role="status">{result.text}</p>}
  </article>
}

// ---------------------------------------------------------------- facts

export function FactsPanel({ story }: { story: OrderStory }) {
  const { facts, now } = story
  const overtaken = new Set(story.triage.overtaken.map((o) => o.ref.id))
  const linked = new Set(story.timeline.map((e) => e.ref.id))
  const current = facts.filter((f) => !f.supersededByFactId && f.level !== "refuted" && f.level !== "stale" && !overtaken.has(f.sourceId))
  const old = facts.filter((f) => !current.includes(f))
  return <section className="sec" aria-labelledby="facts-h">
    <div className="sec-head"><h2 id="facts-h">What we know</h2><span className="note">How sure we are, who said it, the record it comes from, and when.</span></div>
    {facts.length === 0 && <p className="empty">No facts recorded on this order yet.</p>}
    <ul className="fact-list">{current.map((f) => <li key={f.id}><FactChip fact={f} now={now} linked={linked} /></li>)}</ul>
    {old.length > 0 && <details className="more"><summary><Icon name="chevron" size={12} />{old.length} no longer true or out of date</summary>
      <ul className="fact-list">{old.map((f) => <li key={f.id}><FactChip fact={f} now={now} linked={linked} old /></li>)}</ul></details>}
  </section>
}

// ---------------------------------------------------------------- timeline + calls

const OUTCOME: Record<string, string> = { ANSWERED: "Answered", NO_ANSWER: "No answer", VOICEMAIL: "Voicemail", CLOSED: "Site closed", DROPPED_UNKNOWN: "Dropped, outcome unknown" }
const SPEAKER = { ivr: "Phone menu", ring: "Ringo", site: "Site", system: "Line" } as const

const RECENT = 10

export function Timeline({ story }: { story: OrderStory }) {
  const [all, setAll] = useState(false)
  const factsById = new Map(story.facts.map((f) => [f.id, f]))
  const calls = new Map(story.calls.map((c) => [c.id, c]))
  const hidden = all ? 0 : Math.max(0, story.timeline.length - RECENT)
  // A fact's source link (#src-<id>) opens the full timeline so the target exists.
  useEffect(() => {
    const open = () => { if (location.hash.startsWith("#src-")) { setAll(true); requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" })) } }
    window.addEventListener("hashchange", open); open()
    return () => window.removeEventListener("hashchange", open)
  }, [])
  return <section className="sec" aria-labelledby="tl-h">
    <div className="sec-head"><h2 id="tl-h">What happened</h2><span className="count num">{story.timeline.length || ""}</span><span className="note">Oldest first. Who said what, and when.</span></div>
    {story.timeline.length === 0 && <p className="empty">Nothing has happened on this order yet.</p>}
    {hidden > 0 && <button type="button" className="link-btn" onClick={() => setAll(true)}>Show {hidden} earlier {hidden === 1 ? "entry" : "entries"}</button>}
    <ol className="tl">{story.timeline.slice(hidden).map((e, i) => <TimelineEntry key={`${e.ref.id}-${i}`} entry={e} now={story.now} facts={e.factIds.map((id) => factsById.get(id)).filter((f): f is Fact => !!f)} call={e.ref.table === "ring_calls" ? calls.get(e.ref.id) : undefined} />)}</ol>
  </section>
}

function TimelineEntry({ entry: e, now, facts, call }: { entry: StoryEntry; now: string; facts: Fact[]; call?: CallRecord }) {
  const [open, setOpen] = useState(false)
  return <li className={`tl-item kind-${e.actorKind}`} id={`src-${e.ref.id}`}>
    <span className="tl-time"><When at={e.at} now={now} /></span>
    <div className="tl-body">
      <p className="tl-who"><b>{e.actor}</b>{e.channel && <span className="tl-channel">{e.channel.replace(/_/g, " ")}</span>}{e.simulated && <Simulated />}</p>
      <p className="tl-text">{e.text}</p>
      {facts.length > 0 && <ul className="fact-list inline">{facts.map((f) => <li key={f.id}><FactChip fact={f} now={now} /></li>)}</ul>}
      {call && <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide the call" : "Read the call"}</button>}
      {call && open && <CallView call={call} now={now} />}
    </div>
  </li>
}

export function CallView({ call, now, live = false }: { call: CallRecord | { id: string; transcript: CallRecord["transcript"]; outcome: CallRecord["outcome"]; purpose?: string; reconciledFrom?: CallRecord["reconciledFrom"] }; now: string | null; live?: boolean }) {
  const [speaking, setSpeaking] = useState(false)
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window
  useEffect(() => () => { if (canSpeak) window.speechSynthesis.cancel() }, [canSpeak])

  function listen() {
    const synth = window.speechSynthesis
    if (speaking) { synth.cancel(); setSpeaking(false); return }
    synth.cancel()
    call.transcript.forEach((t, i) => {
      const u = new SpeechSynthesisUtterance(t.text)
      u.pitch = t.speaker === "ring" ? 1.1 : t.speaker === "ivr" ? 0.8 : 1
      u.rate = 1.05
      if (i === call.transcript.length - 1) u.onend = () => setSpeaking(false)
      synth.speak(u)
    })
    setSpeaking(true)
  }

  return <div className="call">
    <div className="call-head">
      <Simulated>Simulated call</Simulated>
      {call.purpose && <span className="call-purpose">{call.purpose}</span>}
      {call.outcome ? <span className={`chip tone-${call.outcome === "ANSWERED" ? "ok" : "warn"}`}>{OUTCOME[call.outcome]}</span> : live ? <span className="chip tone-accent"><span className="chip-dot live-dot" />On the line</span> : null}
      {canSpeak && call.transcript.length > 0 && <button type="button" className="btn small" onClick={listen} aria-pressed={speaking}>{speaking ? "Stop" : "Listen"}</button>}
    </div>
    {call.reconciledFrom && <p className="call-reconciled"><b>Before redialling, Ringo checked:</b> {call.reconciledFrom.finding}</p>}
    {call.transcript.length === 0 && <p className="empty">Dialling…</p>}
    <ol className="transcript">{call.transcript.map((t, i) => <li key={i} className={`turn sp-${t.speaker}`}>
      <span className="turn-who">{SPEAKER[t.speaker]}</span>
      <span className="turn-text">{t.dtmf ? <><span className="dtmf">Pressed {t.dtmf}</span> </> : null}{t.dtmf && t.text.startsWith("Pressed") ? null : t.text}</span>
      <span className="turn-at"><When at={t.at} now={now} /></span>
    </li>)}</ol>
  </div>
}
