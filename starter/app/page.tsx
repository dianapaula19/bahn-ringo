"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import type { Handover, QueueItem, QueueResponse } from "@/lib/contract"
import { relativeTo } from "@/lib/present/time"
import { withBase } from "@/lib/base"
import { loadHandover, loadQueue } from "./_lib/agent-api"
import { AppFrame } from "./components/app-frame"
import { Icon } from "./components/icons"
import { Ago, When, agentStatus } from "./components/ring/bits"

const PAGE = 50
const SEEN_KEY = "ring.lastSeen"

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

  const moving = queue ? queue.total - queue.needsYou.length : 0

  return <AppFrame section="queue" snapshotAt={queue?.snapshotAt ?? null}><main className="page queue-page">
    <HandoverStrip now={queue?.now ?? null} />
    <header className="queue-head">
      <h1>Needs you{queue && queue.needsYou.length > 0 && <span className="queue-count num">{queue.needsYou.length}</span>}</h1>
      <p className="queue-sub">{queue
        ? <>Checked <When at={queue.now} now={queue.now} /> · {queue.total} orders · <span className="kbd-hint">j / k to move, Enter to open</span></>
        : "Checking every order…"}</p>
    </header>
    {error && <p className="board-error" role="alert">{error}. Check that the app and database are running.</p>}

    {!queue && !error && <ul className="q-list" aria-busy="true" aria-label="Loading">{[0, 1, 2, 3, 4].map((i) => <li key={i} className="q-skel" />)}</ul>}

    {queue && queue.needsYou.length === 0 && <div className="calm">
      {/* eslint-disable-next-line @next/next/no-img-element -- a static svg needs no optimiser */}
      <img className="calm-ringo" src={withBase("/ringo.svg")} alt="Ringo" width={125} height={140} />
      <div><p className="calm-title">Nothing needs you.</p><p className="calm-sub">Quiet on the lot. {moving} orders moving; one shows up here the moment a person is needed.</p></div>
    </div>}
    {queue && queue.needsYou.length > 0 && <NeedsYouGroups items={queue.needsYou} now={queue.now} />}

    {queue && <section className="sec" aria-labelledby="ring-h">
      <div className="sec-head"><h2 id="ring-h">Ringo is on it</h2><span className="count num">{queue.ring.length || ""}</span>
        <span className="note">Pickup checks Ringo can do by phone. Open one to run it.</span></div>
      {queue.ring.length ? <Rows items={queue.ring} now={queue.now} label="Orders Ringo can work" /> : <p className="empty">Ringo has nothing to check right now.</p>}
    </section>}

    {queue && <details className="fine">
      <summary><Icon name="chevron" size={13} className="chev" />Everything else is fine<span className="fine-count num">{queue.waiting.length + queue.quietCount}</span></summary>
      <div className="fine-body">
        {queue.waiting.length > 0 && <><h3 className="sub">Waiting on someone else · {queue.waiting.length}</h3><Rows items={queue.waiting} now={queue.now} label="Orders waiting on a reply" /></>}
        <p className="empty">{queue.quietCount} orders have no open alert, task or question. <Link href="/board">See all orders</Link></p>
      </div>
    </details>}
  </main></AppFrame>
}

// Most urgent first: safety and high-severity cards on top, routine follow-ups below. Rank order is kept inside each group.
function NeedsYouGroups({ items, now }: { items: QueueItem[]; now: string }) {
  const urgent = items.filter((q) => q.severity === "critical" || q.severity === "high")
  const later = items.filter((q) => !urgent.includes(q))
  return <>
    {urgent.length > 0 && <><h2 className="q-group">Now · {urgent.length}</h2><Rows items={urgent} now={now} label="Orders that need a person now" person /></>}
    {later.length > 0 && <><h2 className="q-group">When you can · {later.length}</h2><Rows items={later} now={now} label="Routine follow-ups" person /></>}
  </>
}

function Rows({ items, now, label, person = false }: { items: QueueItem[]; now: string; label: string; person?: boolean }) {
  const [shown, setShown] = useState(PAGE)
  return <>
    <ul className="q-list" aria-label={label}>
      {items.slice(0, shown).map((q) => {
        const status = agentStatus(q)
        return <li key={q.orderId}><Link data-row className={`q-row sev-${q.severity}`} href={`/orders/${q.orderId}`}>
          <span className="q-sev" aria-label={`Severity ${q.severity}`} />
          <span className="q-id"><span className="mono q-ref">{q.reference}</span><span className="q-vehicle">{q.vehicle}</span></span>
          <span className="q-why" title={q.why}>{q.why}</span>
          <span className={`q-status${status.tone === "accent" ? " tone-accent" : ""}`}>{status.text}</span>
          <Due at={q.decideBy} now={now} person={person} />
        </Link></li>
      })}
    </ul>
    {items.length > shown && <button type="button" className="show-more" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, items.length - shown)} more of {items.length - shown}</button>}
  </>
}

// Only an overdue card that needs a person is red; Ringo's and waiting rows stay calm.
function Due({ at, now, person }: { at: string | null; now: string; person: boolean }) {
  const rel = relativeTo(at, now)
  if (!at || !rel) return <span className="q-due" />
  return <span className={`q-due${rel.past && person ? " tone-danger" : ""}`}>{rel.past ? <>Overdue by {rel.text.replace(/ ago$/, "")}</> : <>Decide <Ago at={at} now={now} /></>}</span>
}

function HandoverStrip({ now }: { now: string | null }) {
  const [since, setSince] = useState<string | null | undefined>(undefined)
  const [handover, setHandover] = useState<Handover | null>(null)
  const [error, setError] = useState(false)
  const [all, setAll] = useState(false)

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
  return <section className="handover" aria-labelledby="handover-h">
    <div className="handover-head">
      <h2 id="handover-h">Since you left</h2>
      {handover && <span className="handover-since">since <When at={handover.since} now={now} /></span>}
      {since && <button type="button" className="link-btn" onClick={() => setSince(null)}>Show the last 3 hours</button>}
    </div>
    {!handover && !error && <div className="handover-skel" aria-busy="true"><span /><span /></div>}
    {error && <p className="empty">The handover could not be loaded. The queue below is still current.</p>}
    {handover && lines.length === 0 && <p className="empty">Nothing new happened while you were away.</p>}
    {lines.length > 0 && <ul className="handover-list">
      {(all ? lines : lines.slice(0, 3)).map((s, i) => <li key={i}>{s.orderId ? <Link href={`/orders/${s.orderId}`}>{s.text}</Link> : s.text}</li>)}
    </ul>}
    <div className="handover-foot">
      {lines.length > 3 && <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>{all ? "Show less" : `Show all ${lines.length}`}</button>}
      {handover && handover.dropped > 0 && <span className="handover-dropped">{handover.dropped} {handover.dropped === 1 ? "line was" : "lines were"} left out because the source could not be found.</span>}
    </div>
  </section>
}
