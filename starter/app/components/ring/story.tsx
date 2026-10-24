"use client"

import Link from "next/link"
import { useEffect, useState, type ReactNode } from "react"
import posthog from "posthog-js"
import { fieldLabel } from "@/lib/present/labels"
import type { CallRecord, Fact, OrderStory, Proposal, ReviewDecision, StoryEntry } from "@/lib/contract"
import type { LearnedRule, ReviewWithSuggestion } from "@/lib/agent/learn/types"
import { DESK, reviewProposal } from "../../_lib/agent-api"
import { Icon } from "../icons"
import { ACTION, FactChip, MODE, Simulated, When, entryRole, factLizard } from "./bits"
import { RingoFace, RoleTag } from "../ringo"
import { withBase } from "@/lib/base"
import type { Detail } from "../order-detail"
import { CallView } from "./call-view"

export { CallView }

// ---------------------------------------------------------------- plain-words payloads

const human = fieldLabel

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

/** What the hero needs from the order record: who to reach, and the open tasks with their next action. */
export type HeroContext = {
  customer: { id: string; name: string } | null
  driver: { id: string; name: string } | null
  tasks: { id: string; nextAction: string | null; dueAt: string | null }[]
}

/** The starter's order API (/api/orders/:id) plus the assigned drivers, which RecordView does not carry. */
export type OrderDetail = Detail & { drivers?: { id: string; displayName: string }[] }

export function heroContext(detail: OrderDetail | null): HeroContext | null {
  if (!detail) return null
  const h = detail.view.header
  return {
    customer: h ? { id: h.customer.id, name: h.customer.name } : null,
    driver: detail.drivers?.[0] ? { id: detail.drivers[0].id, name: detail.drivers[0].displayName } : null,
    tasks: detail.view.workItems.filter((w) => w.status === "OPEN" || w.status === "NEEDS_EXTERNAL_INPUT").map((w) => ({ id: w.id, nextAction: w.nextAction, dueAt: w.dueAt })),
  }
}

type Next = { text: string; context?: ReactNode; source?: ReactNode }

const sentences = (t: string) => t.match(/[^.!?]+[.!?]+(\s|$)/g)?.map((x) => x.trim()) ?? [t]
const blocked = (p: Proposal) => !!p.gate?.findings.some((f) => f.effect === "block")

/** Where a "Next:" line comes from when nothing more specific says so: the triage source rows that are on the
 *  timeline, each linked to its entry ("From Monitoring 11:07 EEST, Kasper Kovelund 11:22 EEST"). */
function fromRecords(story: OrderStory, orderHref: string): ReactNode {
  const entries = story.triage.sources.map((s) => story.timeline.find((e) => e.ref.id === s.id)).filter((e): e is StoryEntry => !!e).slice(0, 3)
  if (!entries.length) return null
  return <>From {entries.map((e, i) => <span key={e.ref.id}>{i > 0 && ", "}<a href={orderHref ? withBase(`${orderHref}#src-${e.ref.id}`) : `#src-${e.ref.id}`}>{e.actor} <When at={e.at} now={story.now} /></a></span>)}</>
}

function nextStep(story: OrderStory, ctx: HeroContext | null, ringPending: Proposal[], orderHref: string): Next | null {
  const n = nextStepFrom(story, ctx, ringPending)
  return n && !n.source ? { ...n, source: fromRecords(story, orderHref) } : n
}

/** One "Next:" line, built only from rows the story already carries; null when nothing concrete is known. */
function nextStepFrom(story: OrderStory, ctx: HeroContext | null, ringPending: Proposal[]): Next | null {
  const { triage, decision } = story
  const lastRun = [...story.runs].sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0]
  const byRingo = lastRun && decision ? <>Ringo, <When at={lastRun.startedAt} now={story.now} /></> : null
  if (ringPending.length) return { text: `Accept, edit or reject Ringo's ${ringPending.length === 1 ? "proposal" : `${ringPending.length} proposals`}.`, source: <>Ringo, <When at={ringPending[0].createdAt} now={story.now} /></> }
  if (triage.bucket === "ring") return triage.reason === "RING_WORKING" ? { text: "Nothing yet. Ringo is on it." } : { text: "Run Ringo. He calls the site and brings back one decision." }
  // Once his proposals are all reviewed, Ringo's "approve this" is done; what he said comes next is the next step.
  const settled = decision?.outcome === "proposal_ready" && story.proposals.some((p) => p.origin === "ring" && p.status !== "PENDING_REVIEW")
  if (settled && decision?.whatNext) {
    const s = sentences(decision.whatNext.replace(/^(after|once) (approval|approved|you approve)[^,]*,\s*/i, "").replace(/^\w/, (c) => c.toUpperCase()))
    return { text: s[0], context: s.length > 1 ? s.slice(1).join(" ") : undefined, source: byRingo }
  }
  const one = (settled ? null : decision?.oneDecision) ?? triage.oneDecision
  if (one) {
    const s = sentences(one)
    const context = s.length > 1 ? s.slice(0, -1).join(" ") : decision?.whatNext ? <>Meanwhile: {decision.whatNext}</> : undefined
    return { text: s[s.length - 1], context, source: byRingo }
  }
  if (decision?.whatNext && triage.bucket === "needs_you") return { text: decision.whatNext, source: byRingo }
  const task = ctx?.tasks.find((t) => triage.sources.some((s) => s.id === t.id) && t.nextAction) ?? (triage.bucket === "needs_you" ? ctx?.tasks.find((t) => t.nextAction) : undefined)
  if (task?.nextAction) return { text: sentences(task.nextAction)[0], source: <>Open task{task.dueAt && <>, due <When at={task.dueAt} now={story.now} /></>}</> }
  const recorded = story.proposals.find((p) => p.origin === "dataset" && p.status === "PENDING_REVIEW" && !blocked(p))
  if (recorded) return { text: recorded.summary, source: <>Recorded proposal, <When at={recorded.createdAt} now={story.now} />. Do it by hand; it can&apos;t be accepted here.</> }
  switch (triage.reason) {
    case "SAFETY": return { text: "Check on the driver." }
    case "FAILED_ACTION": return { text: "Find out what really happened before anyone retries." }
    case "AUTHORITY_BLOCKED": return { text: "Only the customer can clear this. Decide whether and how to contact them." }
    case "DRIVER_WAITING": return { text: story.ringEligible ? "Answer the driver. Ringo can check with the site first." : "Answer the driver." }
    case "CUSTOMER_CONTACT": return { text: "Contact the customer. Ringo never does." }
    default: return null
  }
}

/** The hero offers "Run Ringo" when running him is the next step. Then it is the page's only Run button:
 *  Ringo's panel below hides its own and starts when the hero asks. Once he has stopped with a decision,
 *  running him again is not the next step, so the panel keeps the button instead. */
export function heroCanRun(story: OrderStory): boolean {
  const { triage, decision } = story
  const pending = story.proposals.some((p) => p.origin === "ring" && p.status === "PENDING_REVIEW")
  const live = story.runs.some((r) => r.status === "running")
  return story.ringEligible && !pending && !live && (triage.bucket === "ring" || (triage.bucket === "needs_you" && !decision))
}

const ORDINAL: Record<number, string> = { 2: "Second", 3: "Third" }
type Reviewed = { text: string; tone: string; suggestion: LearnedRule | null }

/** `onRun` starts Ringo's panel on the order page; without it (decide mode) the hero shows no Run button.
 *  `orderHref` makes in-page links (#src-…) point at the order page when the hero is shown elsewhere. */
export function DecisionPanel({ story, ctx, onChanged, onRun, running = false, orderHref = "" }: {
  story: OrderStory; ctx: HeroContext | null; onChanged: () => void; onRun?: () => void; running?: boolean; orderHref?: string
}) {
  const { triage, decision } = story
  // A reviewed card leaves the list on refresh, so its result (and Ringo's rule suggestion) is kept here.
  const [reviewed, setReviewed] = useState<Reviewed | null>(null)
  const ringPending = story.proposals.filter((p) => p.origin === "ring" && p.status === "PENDING_REVIEW")
  const earlier = story.proposals.filter((p) => p.origin === "dataset" && p.status === "PENDING_REVIEW")
  const next = nextStep(story, ctx, ringPending, orderHref)
  const canRun = !!onRun && (heroCanRun(story) || running)
  const runButton = (primary: boolean) =>
    <button type="button" className={`btn${primary ? " primary" : ""}`} disabled={running} onClick={onRun} aria-controls="ringo"><Icon name="bot" size={15} /> {running ? "Ringo is working…" : "Run Ringo"}</button>
  const tone = triage.bucket === "needs_you" ? (triage.severity === "critical" ? "danger" : "warn") : triage.bucket === "ring" ? "accent" : "ok"
  const recorded = triage.reason === "RECORDED_PROPOSAL" ? earlier.find((p) => !blocked(p)) : undefined
  // With a stop decision, Ringo's headline says what he found; the proposal card below says what he asks.
  // Once his proposals are reviewed, what he found still beats the dataset's older "waiting on…" line.
  const settled = decision?.outcome === "proposal_ready" && story.proposals.some((p) => p.origin === "ring" && p.status !== "PENDING_REVIEW")
  const problem = decision && (decision.outcome === "needs_person" || ringPending.length || settled) ? decision.headline : recorded?.rationale || triage.why
  const msg = triage.sources.find((s) => s.table === "messages" && story.timeline.some((e) => e.ref.id === s.id))
  const say = next?.text ?? ""
  const links = [
    ctx?.driver && /\b(answer|ask|tell|call|message)\b[^.]*\bdriver\b/i.test(say) && { href: `/drivers/${ctx.driver.id}`, label: ctx.driver.name, role: "Driver" },
    ctx?.customer && /\b(contact|ask|tell|call|decide with|confirm with)\b[^.]*\bcustomer\b/i.test(say) && { href: `/customers/${ctx.customer.id}`, label: ctx.customer.name, role: "Customer" },
    msg && { href: `${orderHref}#src-${msg.id}`, label: "Read the message", role: "" },
  ].filter((l): l is { href: string; label: string; role: string } => !!l)

  return <section className={`decision d-${tone}`} aria-labelledby="decision-h">
    <h2 className="sr-only" id="decision-h">{triage.bucket === "needs_you" ? "Why this needs you" : "Where this stands"}</h2>
    <p className="decision-text">{problem}</p>
    {next ? <div className="decision-next">
      <p><b>Next:</b> {next.text}</p>
      {next.context && <p className="decision-context">{next.context}</p>}
      {next.source && <p className="decision-src">{next.source}</p>}
    </div> : triage.bucket !== "needs_you" && <p className="decision-next">Nothing waits on you.</p>}
    {(canRun || links.length > 0) && <div className="actions decision-actions">
      {canRun && triage.bucket === "ring" && runButton(true)}
      {links.map((l, i) => {
        const cls = `btn${i === 0 && triage.bucket !== "ring" ? " primary" : ""}`
        return l.href.includes("#") ? <a key={l.href} className={cls} href={l.href.startsWith("#") ? l.href : withBase(l.href)}>{l.label}</a>
          : <Link key={l.href} className={cls} href={l.href}><span className="btn-role">{l.role}</span>{l.label}<Icon name="arrow" size={13} /></Link>
      })}
      {canRun && triage.bucket !== "ring" && runButton(!links.length)}
    </div>}
    {ringPending.map((p) => <ProposalCard key={p.id} proposal={p} story={story} onChanged={onChanged} onReviewed={setReviewed} />)}
    {reviewed && <p className={`result tone-${reviewed.tone}`} role="status">{reviewed.text}</p>}
    {reviewed?.suggestion && <div className="learn-banner" role="status">
      <RingoFace size={28} />
      <p>{ORDINAL[reviewed.suggestion.citations.length] ?? `${reviewed.suggestion.citations.length}th`} time you&apos;ve fixed me the same way. I wrote it up as a rule for you to look at. <Link href="/trust#suggested">See my suggestion</Link></p>
    </div>}
    {triage.overtaken.length > 0 && <ul className="overtaken">{triage.overtaken.map((o) => <li key={o.ref.id}><s>{o.label}</s> overtaken by a later signal at <When at={o.overtakenAt} now={story.now} /></li>)}</ul>}
    {(earlier.length > 0 || (decision?.did.length ?? 0) > 0) && <div className="decision-more">
      {decision && decision.did.length > 0 && <details className="more"><summary><Icon name="chevron" size={12} />What Ringo did</summary><ul className="decision-did">{decision.did.map((d, i) => <li key={i}>{d}</li>)}</ul></details>}
      {earlier.map((p) => <details key={p.id} className="more"><summary><Icon name="chevron" size={12} />Earlier proposal ({blocked(p) ? "blocked by reviewer check" : "recorded, read-only"})</summary><ProposalCard proposal={p} story={story} onChanged={onChanged} /></details>)}
    </div>}
  </section>
}

export function ProposalCard({ proposal: p, story, onChanged, onReviewed }: { proposal: Proposal; story: OrderStory; onChanged: () => void; onReviewed?: (r: Reviewed) => void }) {
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
    const r: ReviewWithSuggestion = await reviewProposal(p.id, { decision, note: note.trim() || null, finalPayload: decision === "EDITED" ? draft : undefined, reviewerId: DESK })
    setBusy(false)
    if ("error" in r) { setResult({ text: r.error, tone: "danger" }); return }
    const done = r.execution?.status === "STALE" ? { text: "The order changed after Ringo wrote this, so nothing was changed. Run Ringo again so he re-reads first.", tone: "warn" }
      : r.execution?.status === "FAILED" ? { text: `It did not go through: ${r.execution.error ?? "unknown error"}. Check before trying again.`, tone: "danger" }
      : { text: r.next, tone: "ok" }
    if (onReviewed) onReviewed({ ...done, suggestion: r.suggestion ?? null }); else setResult(done)
    posthog.capture("proposal_reviewed", {
      action_type: p.actionType,
      decision,
      origin: p.origin,
    })
    setMode("idle"); onChanged()
  }

  return <article className="proposal-card" data-proposal={readOnly ? undefined : p.id} data-mode={mode}>
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

    {readOnly ? <p className="proposal-foot">Recorded before Ringo. Shown for context; it can&apos;t be reviewed here.</p>
      : <div className="actions">
        {mode === "idle" && <>
          <button type="button" className="btn primary" data-key="a" disabled={busy || blocks.length > 0} onClick={() => send("APPROVED")}>Accept</button>
          <button type="button" className="btn" data-key="e" disabled={busy} onClick={() => setMode("edit")}>Edit</button>
          <button type="button" className="btn" data-key="r" disabled={busy} onClick={() => setMode("reject")}>Reject</button>
        </>}
        {mode === "edit" && <><button type="button" className="btn primary" data-submit disabled={busy || !note.trim()} onClick={() => send("EDITED")}>Accept with my changes</button><button type="button" className="btn" data-cancel onClick={() => { setMode("idle"); setDraft(p.proposedPayload); setNote("") }}>Cancel</button></>}
        {mode === "reject" && <><button type="button" className="btn danger" data-submit disabled={busy || !note.trim()} onClick={() => send("REJECTED")}>Reject</button><button type="button" className="btn" data-cancel onClick={() => { setMode("idle"); setNote("") }}>Cancel</button></>}
      </div>}
    {result && <p className={`result tone-${result.tone}`} role="status">{result.text}</p>}
  </article>
}

// ---------------------------------------------------------------- facts

export function FactsPanel({ story }: { story: OrderStory }) {
  const { facts, now } = story
  const overtaken = new Set(story.triage.overtaken.map((o) => o.ref.id))
  const kinds = new Map(story.timeline.map((e) => [e.ref.id, e.actorKind]))
  const linked = new Set(kinds.keys())
  const current = facts.filter((f) => !f.supersededByFactId && f.level !== "refuted" && f.level !== "stale" && !overtaken.has(f.sourceId))
  const old = facts.filter((f) => !current.includes(f))
  return <section className="sec" aria-labelledby="facts-h">
    <div className="sec-head"><h2 id="facts-h">What we know</h2><span className="note">How sure we are, who said it, the record it comes from, and when.</span></div>
    {facts.length === 0 && <p className="empty">No facts recorded on this order yet.</p>}
    <ul className="fact-list">{current.map((f) => <li key={f.id}><FactChip fact={f} now={now} linked={linked} who={factLizard(f, kinds)} /></li>)}</ul>
    {old.length > 0 && <details className="more"><summary><Icon name="chevron" size={12} />{old.length} no longer true or out of date</summary>
      <ul className="fact-list">{old.map((f) => <li key={f.id}><FactChip fact={f} now={now} linked={linked} who={factLizard(f, kinds)} old /></li>)}</ul></details>}
  </section>
}

// ---------------------------------------------------------------- timeline + calls

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
      <p className="tl-who"><RoleTag role={entryRole(e.actorKind)} /><b>{e.actor}</b>{e.channel && <span className="tl-channel">{e.channel.replace(/_/g, " ")}</span>}{e.simulated && <Simulated />}</p>
      <p className="tl-text">{e.text}</p>
      {facts.length > 0 && <ul className="fact-list inline">{facts.map((f) => <li key={f.id}><FactChip fact={f} now={now} /></li>)}</ul>}
      {call && <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide the call" : "Read the call"}</button>}
      {call && open && <CallView call={call} now={now} />}
    </div>
  </li>
}
