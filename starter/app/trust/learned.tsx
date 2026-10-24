"use client"

// Ringo learns from your edits: his suggestions (top of /trust) and the rules people accepted (in the ledger).
import Link from "next/link"
import { useState } from "react"
import type { Citation, LearnedDecision, LearnedRule, LearnedVersion } from "@/lib/agent/learn/types"
import { decideLearned } from "../_lib/agent-api"
import { Icon } from "../components/icons"
import { RingoFace } from "../components/ringo"
import { ACTION, When } from "../components/ring/bits"

const step = (h: LearnedVersion, prev?: LearnedVersion) =>
  !prev ? "accepted" : h.status !== prev.status ? (h.status === "off" ? "switched off" : "switched on") : `reworded (version ${h.version})`
const desk = (d: string) => `${d.replace(/^ops-/, "").replace(/^\w/, (c) => c.toUpperCase())} desk`

/** Ringo's line after each decision. */
function said(rule: LearnedRule, action: LearnedDecision["action"]): string {
  switch (action) {
    case "accept": return `Done. ${rule.ruleId} is in the rule book, and I stick to it from my next proposal.`
    case "dismiss": return "Fair enough. I won't ask about that one again."
    case "off": return `${rule.ruleId} is off. I've stopped checking it; the history stays.`
    case "on": return `${rule.ruleId} is back on.`
    case "edit": return `${rule.ruleId} now reads your way (version ${rule.version}).`
  }
}

function Cites({ citations, now }: { citations: Citation[]; now: string }) {
  return <ul className="learn-cites">{citations.map((c) => <li key={c.correctionId}>
    <Link href={`/orders/${c.orderId}`} className="mono">{c.orderRef}</Link>
    <span> {c.decision === "EDITED" ? "edited" : "rejected"} <When at={c.at} now={now} /> by the {desk(c.reviewerId).toLowerCase()}</span>
    {c.note && <q>{c.note}</q>}
  </li>)}</ul>
}

function useDecide(onChanged: () => void) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; tone: string } | null>(null)
  async function run(rule: LearnedRule, action: LearnedDecision["action"], text?: string) {
    setBusy(true)
    const r = await decideLearned(rule.id, action, text)
    setBusy(false)
    setMsg("error" in r ? { text: r.error, tone: "danger" } : { text: said(r.rule, action), tone: "ok" })
    if (!("error" in r)) onChanged()
  }
  return { busy, msg, run }
}

function Wording({ initial, onSave, onCancel, busy, saveLabel }: { initial: string; onSave: (t: string) => void; onCancel: () => void; busy: boolean; saveLabel: string }) {
  const [text, setText] = useState(initial)
  return <>
    <label className="field"><span>The rule, in your words</span><textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} autoFocus /></label>
    <div className="actions">
      <button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={() => onSave(text)}>{saveLabel}</button>
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
    </div>
  </>
}

export function Suggestions({ rules, now, onChanged }: { rules: LearnedRule[]; now: string; onChanged: () => void }) {
  const open = rules.filter((r) => r.status === "suggested")
  if (!open.length) return null
  return <section className="sec learn-suggest" id="suggested" aria-labelledby="suggest-h">
    <h2 className="sr-only" id="suggest-h">Ringo suggests a rule</h2>
    {open.map((r) => <SuggestionCard key={r.id} rule={r} now={now} onChanged={onChanged} />)}
  </section>
}

function SuggestionCard({ rule, now, onChanged }: { rule: LearnedRule; now: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const { busy, msg, run } = useDecide(onChanged)
  return <article className="learn-card">
    <RingoFace size={44} />
    <div className="learn-body">
      <p className="eyebrow">Ringo suggests a rule</p>
      <p className="learn-ask">{rule.ask}</p>
      {!editing && <p className="learn-rule"><span>The rule would read:</span> {rule.text}</p>}
      <details className="more"><summary><Icon name="chevron" size={12} />From {rule.citations.length} of your reviews</summary><Cites citations={rule.citations} now={now} /></details>
      {editing ? <Wording initial={rule.text} busy={busy} saveLabel="Accept with this wording" onSave={(t) => run(rule, "accept", t)} onCancel={() => setEditing(false)} />
        : <div className="actions">
          <button type="button" className="btn primary" disabled={busy} onClick={() => run(rule, "accept")}>Accept</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>Edit wording</button>
          <button type="button" className="btn" disabled={busy} onClick={() => run(rule, "dismiss")}>Don&apos;t ask again</button>
        </div>}
      <p className="learn-foot">Nothing changes until you say yes. A rule only stops my proposals; it never acts on an order.</p>
      {msg && <p className={`result tone-${msg.tone}`} role="status">{msg.text}</p>}
    </div>
  </article>
}

export function LearnedRules({ rules, now, onChanged }: { rules: LearnedRule[]; now: string; onChanged: () => void }) {
  const decided = rules.filter((r) => r.status === "active" || r.status === "off")
  return <section className="sec" id="learned" aria-labelledby="learned-h">
    <div className="sec-head"><h2 id="learned-h">Rules Ringo learned from you</h2><span className="count num">{decided.length || ""}</span>
      <span className="note">Part of the reviewer check. Each one cites the reviews it came from.</span></div>
    {decided.length === 0 ? <p className="empty">None yet. Correct Ringo the same way twice and he&apos;ll ask whether to make it a rule.</p>
      : <ul className="trust-list">{decided.map((r) => <LearnedRow key={r.id} rule={r} now={now} onChanged={onChanged} />)}</ul>}
  </section>
}

function LearnedRow({ rule, now, onChanged }: { rule: LearnedRule; now: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const { busy, msg, run } = useDecide(() => { setEditing(false); onChanged() })
  const on = rule.status === "active"
  const accepted = rule.history.find((h) => h.status === "active")
  return <li className={`learn-row${on ? "" : " is-off"}`}>
    <div className="trust-main">
      <p className="trust-name"><span className="mono learn-id">{rule.ruleId}</span>{rule.title}
        <span className={`chip ${on ? "tone-accent" : "tone-neutral"}`}>{on ? "On" : "Off"}</span>
        <span className="chip tone-neutral" title="Each change of wording is a new version">Version {rule.version}</span></p>
      {editing ? <Wording initial={rule.text} busy={busy} saveLabel="Save wording" onSave={(t) => run(rule, "edit", t)} onCancel={() => setEditing(false)} />
        : <p className="learn-text">{rule.text}</p>}
      <p className="trust-sub">{ACTION[rule.actionType]}. Learned from {rule.citations.length} reviews{accepted && <>, accepted <When at={accepted.at} now={now} /> by the {desk(accepted.by).toLowerCase()}</>}.</p>
      <details className="more"><summary><Icon name="chevron" size={12} />Where it came from{rule.history.length > 1 ? " and its history" : ""}</summary>
        <Cites citations={rule.citations} now={now} />
        {rule.history.length > 1 && <ol className="learn-history">{rule.history.map((h, i) => <li key={i}>
          <When at={h.at} now={now} />: {step(h, rule.history[i - 1])} by the {desk(h.by).toLowerCase()}</li>)}</ol>}
      </details>
      {msg && <p className={`result tone-${msg.tone}`} role="status">{msg.text}</p>}
    </div>
    {!editing && <div className="trust-act learn-act">
      <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>Edit wording</button>
      <button type="button" className="btn" disabled={busy} onClick={() => run(rule, on ? "off" : "on")}>{on ? "Switch off" : "Switch on"}</button>
    </div>}
  </li>
}
