"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { Handover, QueueItem, QueueResponse } from "@/lib/contract"
import { relativeTo } from "@/lib/present/time"
import { withBase } from "@/lib/base"
import { DESK, loadHandover, loadQueue } from "./_lib/agent-api"
import type { Claim, WithClaim } from "@/lib/triage/claim"
import type { HandoverCounts } from "@/lib/agent/handover"
import { AppFrame } from "./components/app-frame"
import { Icon } from "./components/icons"
import { CAST, LizardFace } from "./components/ringo"
import { Ago, When } from "./components/ring/bits"
import { inNow, nextAction } from "@/lib/triage/next-action"
import "./decide/decide.css"

const PAGE = 50
const SEEN_KEY = "ring.lastSeen"
const ROW_KEY = "ring.openedRow"

function readSeen(): string | null { try { return localStorage.getItem(SEEN_KEY) } catch { return null } }
function writeSeen(at: string) { try { localStorage.setItem(SEEN_KEY, at) } catch { /* private window: strip falls back to the default window */ } }

export default function NeedsYou() {
  const [queue, setQueue] = useState<QueueResponse | null>(null)
  const [error, setError] = useState("")

  const refresh = useCallback((signal?: AbortSignal) => loadQueue(signal)
    .then((data) => { setQueue(data); setError("") })
    .catch((e: unknown) => { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Could not load the queue") }), [])

  useEffect(() => {
    const c = new AbortController()
    refresh(c.signal)
    const timer = setInterval(() => refresh(), 20000)
    const onShow = () => { if (document.visibilityState === "visible") refresh() }
    document.addEventListener("visibilitychange", onShow)
    return () => { c.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", onShow) }
  }, [refresh])

  useEffect(() => {
    if (!queue) return
    const save = () => writeSeen(queue.now)
    window.addEventListener("pagehide", save)
    return () => { save(); window.removeEventListener("pagehide", save) }
  }, [queue])

  // j / k move between rows, Enter opens the focused one (native link behaviour).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "j" && e.key !== "k")) return
      const t = e.target as HTMLElement
      if (t.closest("input, textarea, select, [contenteditable]")) return
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-row]"))
      if (!rows.length) return
      const i = rows.indexOf(document.activeElement as HTMLElement)
      const next = e.key === "j" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)
      rows[next].focus(); rows[next].scrollIntoView({ block: "nearest" })
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Back from an order puts focus on the row it was opened from, not on <body>.
  const loaded = !!queue
  useEffect(() => {
    if (!loaded) return
    try {
      const id = sessionStorage.getItem(ROW_KEY)
      sessionStorage.removeItem(ROW_KEY)
      if (id) document.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.focus()
    } catch { /* storage blocked: focus stays where the browser puts it */ }
  }, [loaded])

  const moving = queue ? queue.total - queue.needsYou.length : 0
  const free = queue?.needsYou.filter((q) => !claimOf(q)) ?? [] // taken rows are not in the decide pass

  return <AppFrame section="queue" snapshotAt={queue?.snapshotAt ?? null}><main className="page queue-page">
    <ShiftReport queue={queue} />
    <header className="queue-head">
      <div className="queue-title">
        <h1 id="needs-h">Needs you{queue && queue.needsYou.length > 0 && <span className="queue-count num">{queue.needsYou.length}</span>}</h1>
        {queue && free.length > 0 && <Link href="/decide" className="btn primary decide-start">Start deciding ({free.length})<Icon name="arrow" size={14} /></Link>}
      </div>
      <p className="queue-sub">{queue
        ? <>Checked <When at={queue.now} now={queue.now} /> · {queue.total} orders<span className="kbd-hint"> · j / k to move, Enter to open</span></>
        : "Checking every order…"}</p>
    </header>
    {error && <p className="board-error" role="alert">{error}. Check that the app and database are running.</p>}

    {!queue && !error && <ul className="q-list" aria-busy="true" aria-label="Loading">{[0, 1, 2, 3, 4].map((i) => <li key={i} className="q-skel" />)}</ul>}

    {queue && queue.needsYou.length === 0 && <div className="calm">
      <div className="calm-cast" role="img" aria-label="Ringo with a pickup site, a customer and a driver">{(["ringo", "dealer", "customer", "driver"] as const).map((who) =>
        // eslint-disable-next-line @next/next/no-img-element -- a static svg needs no optimiser
        <img key={who} src={withBase(CAST[who].src)} alt="" width={107} height={120} />)}</div>
      <div><p className="calm-title">Nothing needs you.</p><p className="calm-sub">Quiet on the lot. {moving} orders moving.</p></div>
    </div>}
    {queue && queue.needsYou.length > 0 && <NeedsYouGroups items={queue.needsYou} now={queue.now} />}

    {queue && <RingoGroups items={queue.ring} now={queue.now} />}

    {queue && <details className="fine">
      <summary><Icon name="chevron" size={13} className="chev" />Everything else is fine<span className="fine-count num">{queue.waiting.length + queue.quietCount}</span></summary>
      <div className="fine-body">
        {queue.waiting.length > 0 && <><h3 className="sub">Waiting on someone else · {queue.waiting.length}</h3><Rows items={queue.waiting} now={queue.now} label="Orders waiting on a reply" /></>}
        <p className="empty">{queue.quietCount} orders have no open alert, task or question. <Link href="/board">See all orders</Link></p>
      </div>
    </details>}
  </main></AppFrame>
}

// Now: safety, or critical/high that is overdue or due within 2 h (lib/triage/next-action.ts). Rank order is kept inside each group.
// Taken: someone said "I'll handle it". The row comes back on its own at the recheck time or when something new happens.
const claimOf = (q: QueueItem) => (q as QueueItem & WithClaim).claim ?? null
function NeedsYouGroups({ items, now }: { items: QueueItem[]; now: string }) {
  const taken = items.filter((q) => claimOf(q))
  const open = items.filter((q) => !claimOf(q))
  const urgent = open.filter((q) => inNow(q, now))
  const later = open.filter((q) => !urgent.includes(q))
  return <>
    {urgent.length > 0 && <><h2 className="q-group" id="now">Now · {urgent.length}</h2><Rows items={urgent} now={now} label="Orders that need a person now" person /></>}
    {later.length > 0 && <><h2 className="q-group">When you can · {later.length}</h2><Rows items={later} now={now} label="Follow-ups" /></>}
    {taken.length > 0 && <><h2 className="q-group">Taken · {taken.length}</h2><Rows items={taken} now={now} label="Orders a person is handling" /></>}
  </>
}

// "Ringo is on it" only for what he is doing now (a live run or a booked callback); the rest he could phone.
function RingoGroups({ items, now }: { items: QueueItem[]; now: string }) {
  const working = items.filter((q) => q.reason === "RING_WORKING")
  const can = items.filter((q) => q.reason !== "RING_WORKING")
  return <>
    {working.length > 0 && <section className="sec" aria-labelledby="ring-on-h">
      <div className="sec-head"><h2 id="ring-on-h">Ringo is on it</h2><span className="count num">{working.length}</span><span className="note">Running now, or calling back at a set time.</span></div>
      <Rows items={working} now={now} label="Orders Ringo is working" />
    </section>}
    <section className="sec" aria-labelledby="ring-h">
      <div className="sec-head"><h2 id="ring-h">Ringo can phone these</h2><span className="count num">{can.length || ""}</span>
        <span className="note">He has not started. Open one and run him.</span></div>
      {can.length ? <Rows items={can} now={now} label="Orders Ringo can work" /> : <p className="empty">Nothing for Ringo to phone right now.</p>}
    </section>
  </>
}

function ClaimLine({ claim, now }: { claim: Claim; now: string }) {
  return <span className="q-claim">{claim.by === DESK ? "You have it" : `${claim.by} has it`} · <When at={claim.at} now={now} /> · back at <When at={claim.recheckAt} now={now} />{claim.note && <> · {claim.note}</>}</span>
}

// Past LONG rows a group shows its first LONG and a "by next step" filter, so 1,000 orders still read at
// a glance. The dataset's 100 orders never reach it (Needs you is 19), so their queue looks the same.
const LONG = 20

function Rows({ items, now, label, person = false }: { items: QueueItem[]; now: string; label: string; person?: boolean }) {
  const long = items.length > LONG
  const page = long ? LONG : PAGE
  const [shown, setShown] = useState(page)
  const [step, setStep] = useState<string | null>(null)
  const steps = useMemo(() => new Map(items.map((q) => [q.orderId, nextAction(q)])), [items])
  const counts = useMemo(() => {
    const m = new Map<string, number>() // rank order: the step of the worst row comes first
    for (const q of items) { const s = steps.get(q.orderId) ?? OTHER; m.set(s, (m.get(s) ?? 0) + 1) }
    return [...m]
  }, [items, steps])
  const list = step ? items.filter((q) => (steps.get(q.orderId) ?? OTHER) === step) : items
  const pick = (s: string | null) => { setStep(s); setShown(page) }
  return <>
    {long && counts.length > 1 && <div className="q-steps" role="group" aria-label={`${label}, by next step`}>
      <button type="button" className="q-step" aria-pressed={!step} onClick={() => pick(null)}>All <span className="num">{items.length}</span></button>
      {counts.map(([s, n]) => <button type="button" key={s} className="q-step" aria-pressed={step === s} onClick={() => pick(step === s ? null : s)}>{s} <span className="num">{n}</span></button>)}
    </div>}
    <ul className="q-list" aria-label={label}>
      {list.slice(0, shown).map((q) => {
        const next = steps.get(q.orderId) ?? null
        return <li key={q.orderId}><Link data-row={q.orderId} className={`q-row${barClass(q, now, person)}`} href={`/orders/${q.orderId}`} onClick={() => { try { sessionStorage.setItem(ROW_KEY, q.orderId) } catch {} }}>
          <span className="q-main">
            <span className="q-why" title={q.why}>{q.reason === "SAFETY" && <span className="sr-only">Safety: </span>}{q.why}</span>
            <span className="q-meta"><span className="mono">{q.reference}</span> · {q.vehicle}</span>
            {claimOf(q) && <ClaimLine claim={claimOf(q)!} now={now} />}
          </span>
          {next ? <span className="q-next">{next}</span> : <span aria-hidden="true" />}
          <Due at={q.decideBy} now={now} person={person} needsYou={q.bucket === "needs_you"} />
        </Link></li>
      })}
    </ul>
    {list.length > shown && <button type="button" className="show-more" onClick={() => setShown((n) => n + page)}>Show {Math.min(page, list.length - shown)} more of {list.length - shown}</button>}
  </>
}

const OTHER = "Other"

// One glance, one colour each: red bar and tint for safety only; orange for a Now row that is overdue
// or has a driver waiting on it; every other row has no bar.
function barClass(q: QueueItem, now: string, person: boolean): string {
  if (q.reason === "SAFETY") return " is-safety"
  if (!person) return ""
  return q.reason === "DRIVER_WAITING" || relativeTo(q.decideBy, now)?.past ? " is-pressing" : ""
}

// Only an overdue card in Now is red; "When you can", Ringo's and waiting rows stay calm.
function Due({ at, now, person, needsYou }: { at: string | null; now: string; person: boolean; needsYou: boolean }) {
  const rel = relativeTo(at, now)
  if (!at || !rel) return <span className="q-due">{needsYou ? "No deadline" : ""}</span>
  return <span className={`q-due num${rel.past && person ? " tone-danger" : ""}`}>{rel.past ? <>Overdue {rel.text.replace(/ ago$/, "")}</> : <>Due <Ago at={at} now={now} /></>}</span>
}

/** Ringo's shift report: three plain lines over the queue and the handover. Counts come from the triaged rows
 *  below; "Show what happened" opens the cited handover sentences, each one tied to its source rows. */
function ShiftReport({ queue }: { queue: QueueResponse | null }) {
  const [since, setSince] = useState<string | null | undefined>(undefined)
  const [handover, setHandover] = useState<Handover | null>(null)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => { setSince(readSeen()) }, [])
  useEffect(() => {
    if (since === undefined) return
    const c = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    const load = (again: boolean) => loadHandover(since, c.signal).then((data) => {
      setHandover(data); setError(false)
      // The Scribe writes in the background; ask once more for its version.
      if (again && data.writer === "template" && data.sentences.length) retry = setTimeout(() => load(false), 12_000)
    }).catch(() => { if (!c.signal.aborted) setError(true) })
    load(true)
    return () => { c.abort(); clearTimeout(retry) }
  }, [since])

  const lines = handover?.sentences ?? []
  // Counts come from the source rows (server), so the Scribe rewording a line never moves them.
  const counts = (handover as (Handover & HandoverCounts) | null)?.counts
  const updates = counts?.updates ?? lines.length
  const orders = counts?.orders ?? new Set(lines.map((s) => s.orderId).filter(Boolean)).size
  const now = queue?.now ?? null
  const free = queue?.needsYou.filter((q) => !claimOf(q)) ?? []
  const urgent = queue ? free.filter((q) => inNow(q, queue.now)).length : 0
  const top = free[0]
  const ready = !!queue && (!!handover || error)

  return <section className="shift" aria-labelledby="shift-h">
    <LizardFace who="ringo" size={48} />
    <div className="shift-body">
      <h2 id="shift-h" className="sr-only">Ringo&apos;s shift report</h2>
      <div className="bubble" aria-busy={!ready}>
        {!ready ? <div className="handover-skel"><span /><span /></div> : <>
          <p>{error ? "I couldn't load what happened while you were out. The queue below is current."
            : updates ? <>Here&apos;s the lot since <When at={handover!.since} now={now} />: {updates} {updates === 1 ? "update" : "updates"} on {orders} {orders === 1 ? "order" : "orders"}.</>
              : <>Nothing new since <When at={handover!.since} now={now} />.</>}</p>
          <p>{top ? <><a href="#needs-h">{queue!.needsYou.length} need you</a>{urgent > 0 && <>, <a href="#now">{urgent} right now</a></>}. Start with the {top.vehicle}.</> : queue!.needsYou.length ? "Everything that needs you is taken. I'll put each back when its time is up." : "Nothing needs you. Enjoy the coffee."}</p>
          {queue!.ring.length > 0 && <p><a href="#ring-h">{queue!.ring.length === 1 ? "One" : queue!.ring.length} I can phone myself</a>. Open {queue!.ring.length === 1 ? "it" : "one"} and say the word.</p>}
        </>}
      </div>
      {(lines.length > 0 || since) && <div className="shift-foot">
        {lines.length > 0 && <button type="button" className="link-btn" aria-expanded={open} aria-controls="shift-log" onClick={() => setOpen((v) => !v)}>{open ? "Hide what happened" : "Show what happened"}</button>}
        {since && <button type="button" className="link-btn" onClick={() => setSince(null)}>Last 3 hours instead</button>}
      </div>}
      {open && <div id="shift-log">
        <ul className="handover-list">{lines.map((s, i) => <li key={i}>{s.orderId ? <Link href={`/orders/${s.orderId}`}>{s.text}</Link> : s.text}</li>)}</ul>
        {handover && handover.dropped > 0 && <p className="handover-dropped">{handover.dropped} {handover.dropped === 1 ? "line was" : "lines were"} left out: no source found.</p>}
      </div>}
    </div>
  </section>
}
