"use client"

// Decision mode: the Needs you queue one card at a time, keyboard first. Every Accept / Edit / Reject goes through
// the same review API as the order page and is recorded per proposal. Cards with no Ringo proposal show the one
// decision and the links to do it; "I'll handle it" only moves this screen on (nothing is written).
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import posthog from "posthog-js"
import type { OrderStory, Proposal, QueueItem, ReviewDecision } from "@/lib/contract"
import { withBase } from "@/lib/base"
import { relativeTo } from "@/lib/present/time"
import { fieldLabel } from "@/lib/present/labels"
import { inNow, nextAction } from "@/lib/triage/next-action"
import { similarGroups, similarKey } from "@/lib/triage/similar"
import { DESK, loadQueue, loadStory, reviewProposal } from "../_lib/agent-api"
import { AppFrame } from "../components/app-frame"
import { Icon } from "../components/icons"
import { CAST, RingoFace, RoleTag } from "../components/ringo"
import { ACTION, Ago, FactChip, When, entryRole, factLizard } from "../components/ring/bits"
import { DecisionPanel, heroContext, plain, type OrderDetail } from "../components/ring/story"
import "./decide.css"

type Done = { how: ReviewDecision | "TAKEN"; stale?: boolean }
type Loaded = { story: OrderStory; detail: OrderDetail | null }
type Status = { text: string; tone: "ok" | "warn" | "danger" | "neutral" }

const TAKEN_KEY = "ring.decide.taken"
const AT_KEY = "ring.decide.at"
const store = {
  get: (k: string) => { try { return sessionStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v) } catch { /* private window: the pass just restarts */ } },
}
const ringPending = (s: OrderStory | undefined) => s?.proposals.filter((p) => p.origin === "ring" && p.status === "PENDING_REVIEW") ?? []
const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input:not([type=checkbox]), textarea, select, [contenteditable]")
const DID: Record<ReviewDecision, string> = { APPROVED: "Accepted", EDITED: "Accepted with your changes", REJECTED: "Rejected" }

async function loadOne(id: string): Promise<Loaded> {
  const [story, detail] = await Promise.all([
    loadStory(id),
    fetch(withBase(`/api/orders/${encodeURIComponent(id)}`), { cache: "no-store" }).then((r) => (r.ok ? r.json() as Promise<OrderDetail> : null)).catch(() => null),
  ])
  return { story, detail }
}

export default function DecidePage() {
  const router = useRouter()
  const [items, setItems] = useState<QueueItem[] | null>(null)
  const [now, setNow] = useState("")
  const [error, setError] = useState("")
  const [order, setOrder] = useState<string[]>([])
  const [idx, setIdx] = useState(0)
  const [done, setDone] = useState<Record<string, Done>>({})
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  const [loadError, setLoadError] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Status | null>(null)
  const [reviewedCount, setReviewedCount] = useState(0)
  const [batch, setBatch] = useState<{ proposals: Proposal[]; stories: Record<string, Loaded>; excluded: Set<string>; results: Record<string, Status> | null; busy: boolean } | null>(null)
  const help = useRef<HTMLDialogElement | null>(null)
  const card = useRef<HTMLElement | null>(null)

  const fetchOne = useCallback((id: string) => loadOne(id).then((l) => { setLoaded((m) => ({ ...m, [id]: l })); return l })
    .catch((e: unknown) => { setLoadError((m) => ({ ...m, [id]: e instanceof Error ? e.message : "Could not load the order" })); return null }), [])

  // The pass: today's Needs you, Now first, in rank order. Fixed at entry so the counter can reach 0.
  useEffect(() => {
    const c = new AbortController()
    loadQueue(c.signal).then((q) => {
      const list = [...q.needsYou.filter((x) => inNow(x, q.now)), ...q.needsYou.filter((x) => !inNow(x, q.now))]
      const ids = list.map((x) => x.orderId)
      const taken = new Set<string>(JSON.parse(store.get(TAKEN_KEY) ?? "[]") as string[])
      const d: Record<string, Done> = {}
      for (const id of ids) if (taken.has(id)) d[id] = { how: "TAKEN" }
      const left = ids.filter((id) => !d[id])
      setItems(list); setNow(q.now); setOrder(ids); setDone(d); setIdx(Math.max(0, left.indexOf(store.get(AT_KEY) ?? "")))
      // Stories of every card with a Ringo proposal, so similar ones can be offered together.
      for (const x of list) if (x.pendingProposalIds.some((p) => !p.startsWith("agent-"))) fetchOne(x.orderId)
    }).catch((e: unknown) => { if (!c.signal.aborted) setError(e instanceof Error ? e.message : "Could not load the queue") })
    return () => c.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, at entry
  }, [])

  const byId = useMemo(() => new Map((items ?? []).map((x) => [x.orderId, x])), [items])
  const left = order.filter((id) => !done[id])
  const at = Math.min(idx, Math.max(0, left.length - 1))
  const id = left[at]
  const cur = id ? loaded[id] : undefined
  const total = order.length
  const decided = total - left.length

  useEffect(() => { if (id) store.set(AT_KEY, id) }, [id])
  // A finished pass forgets what you took by hand, so the next visit starts from today's queue.
  useEffect(() => { if (items && total && !left.length) { store.set(TAKEN_KEY, "[]"); store.set(AT_KEY, "") } }, [items, total, left.length])
  // The current card and the next one load ahead.
  useEffect(() => { for (const x of [id, left[at + 1]]) if (x && !loaded[x] && !loadError[x]) fetchOne(x) })
  // A new card takes focus, so a screen reader reads it and the keys act on it.
  useEffect(() => { if (cur) card.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0 }) }, [id, !!cur]) // eslint-disable-line react-hooks/exhaustive-deps

  // Similar pending proposals across the cards still left (lib/triage/similar.ts).
  const groups = useMemo(() => similarGroups(left.flatMap((o) => ringPending(loaded[o]?.story))), [left.join(), loaded]) // eslint-disable-line react-hooks/exhaustive-deps
  const offer = cur ? groups.find((g) => g.some((p) => p.orderId === id)) : undefined

  function finish(orderId: string, d: Done, s: Status) {
    setDone((m) => ({ ...m, [orderId]: d })); setStatus(s)
  }

  function take() {
    if (!id) return
    const ref = byId.get(id)?.reference
    const taken = new Set<string>(JSON.parse(store.get(TAKEN_KEY) ?? "[]") as string[]); taken.add(id)
    store.set(TAKEN_KEY, JSON.stringify([...taken]))
    finish(id, { how: "TAKEN" }, { text: `${ref} is yours. Noted on this screen only: it stays in Needs you until its records change.`, tone: "neutral" })
  }

  function move(step: number) { if (left.length) setIdx((at + step + left.length) % left.length) }
  function skip() {
    if (!id) return
    if (left.length === 1) { setStatus({ text: "This is the last one.", tone: "neutral" }); return }
    setOrder((o) => [...o.filter((x) => x !== id), id]); setStatus({ text: `${byId.get(id)?.reference} moved to the back.`, tone: "neutral" })
  }

  // After a review on the card: re-read the order. The card is done once no Ringo proposal waits on it.
  async function reviewed(orderId: string) {
    const before = ringPending(loaded[orderId]?.story)
    const l = await fetchOne(orderId)
    if (!l) return
    const changed = l.story.proposals.filter((p) => before.some((b) => b.id === p.id) && p.status !== "PENDING_REVIEW")
    const p = changed.at(-1)
    if (!p?.review) return
    setReviewedCount((n) => n + changed.length)
    const stale = p.execution?.status === "STALE"
    const text = stale ? `${l.story.reference}: your approval is recorded, but the order changed after Ringo read it, so nothing was changed. Run Ringo again from the order.`
      : p.execution?.status === "FAILED" ? `${l.story.reference}: recorded, but it did not go through: ${p.execution.error ?? "unknown error"}.`
        : `${l.story.reference}: ${DID[p.review.decision]}. ${p.review.decision === "REJECTED" ? p.onReject ?? "Nothing changes." : p.onApprove ?? "Done."}`
    const tone = stale ? "warn" : p.execution?.status === "FAILED" ? "danger" : "ok"
    if (ringPending(l.story).length) setStatus({ text, tone })
    else finish(orderId, { how: p.review.decision, stale }, { text, tone })
  }

  async function acceptBatch() {
    if (!batch || batch.busy || batch.results) return
    const pick = batch.proposals.map((p) => p.id).filter((x) => !batch.excluded.has(x))
    if (!pick.length) return
    setBatch({ ...batch, busy: true })
    const props = new Map(batch.proposals.map((p) => [p.id, p]))
    const results: Record<string, Status> = {}
    // One request per proposal, one after another: each approval is rechecked and recorded on its own.
    for (const pid of pick) {
      const p = props.get(pid)!
      const r = await reviewProposal(pid, { decision: "APPROVED", note: null, reviewerId: DESK })
      if ("error" in r) results[pid] = { text: r.error, tone: "danger" }
      else if (r.execution?.status === "STALE") results[pid] = { text: "Recorded. The order changed after Ringo read it, so nothing was changed.", tone: "warn" }
      else if (r.execution?.status === "FAILED") results[pid] = { text: `Recorded, but it did not go through: ${r.execution.error ?? "unknown error"}.`, tone: "danger" }
      else results[pid] = { text: `Accepted. ${p.onApprove ?? ""}`.trim(), tone: "ok" }
      if (!("error" in r)) posthog.capture("proposal_reviewed", { action_type: p.actionType, decision: "APPROVED", origin: "ring", batch: true })
    }
    setBatch((b) => b && { ...b, busy: false, results })
    setReviewedCount((n) => n + Object.values(results).filter((r) => r.tone !== "danger").length)
    const orders = [...new Set(pick.map((pid) => props.get(pid)!.orderId))]
    const fresh = await Promise.all(orders.map(fetchOne))
    const d: Record<string, Done> = {}
    fresh.forEach((l, i) => { if (l && !ringPending(l.story).length) d[orders[i]] = { how: "APPROVED", stale: pick.some((pid) => props.get(pid)!.orderId === orders[i] && results[pid].tone === "warn") } })
    setDone((m) => ({ ...m, ...d }))
    const ok = Object.values(results).filter((r) => r.tone === "ok").length
    setStatus({ text: `${pick.length === 1 ? "Accepted and recorded on its order." : `${ok} of ${pick.length} accepted together, each recorded on its own order.`}${ok < pick.length ? " What happened to the others is listed below." : ""}`, tone: ok === pick.length ? "ok" : "warn" })
  }

  function openBatch() {
    if (!offer) return
    setBatch({ proposals: offer, stories: loaded, excluded: new Set(), results: null, busy: false })
  }

  // Keys. Letters act on the current card; inside a note, Esc cancels and Ctrl/Cmd+Enter sends.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (help.current?.open) return
      const scope = card.current
      if (typing(e.target)) {
        if (e.key === "Escape") { scope?.querySelector<HTMLButtonElement>("[data-cancel]")?.click(); e.preventDefault() }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { scope?.querySelector<HTMLButtonElement>("[data-submit]:not(:disabled)")?.click(); e.preventDefault() }
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key
      if (k === "?") { help.current?.showModal(); e.preventDefault(); return }
      if (k === "Escape") { if (batch) setBatch(null); else router.push("/"); e.preventDefault(); return }
      if (batch) { if (k === "a" || (k === "Enter" && !(e.target as HTMLElement).closest("button, a, input"))) { batch.results ? setBatch(null) : acceptBatch(); e.preventDefault() } return }
      if (!left.length) return
      const btn = (key: string) => scope?.querySelector<HTMLButtonElement>(`[data-proposal][data-mode="idle"] [data-key="${key}"]:not(:disabled)`)
      const hasProposal = !!scope?.querySelector("[data-proposal]")
      const open = !!scope?.querySelector('[data-proposal]:not([data-mode="idle"])')
      const busy = { text: "Finish or cancel the open review first.", tone: "neutral" } as const
      switch (k) {
        case "a": if (btn("a")) btn("a")!.click(); else if (open) setStatus(busy); else if (hasProposal) setStatus({ text: "The reviewer check blocks this proposal. Edit or reject it.", tone: "warn" }); else if (cur) take(); break
        case "e": case "r":
          if (btn(k)) btn(k)!.click()
          else setStatus(hasProposal ? busy : { text: "Nothing to edit or reject here: no Ringo proposal on this order. Use the links on the card, or press A once you have it.", tone: "neutral" })
          break
        case "s": skip(); break
        case "j": move(1); break
        case "k": move(-1); break
        case "o": if (id) router.push(`/orders/${id}`); break
        case "b": openBatch(); break
        default: return
      }
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const q = id ? byId.get(id) : undefined
  const safety = q?.reason === "SAFETY"
  const pending = ringPending(cur?.story)

  return <AppFrame section="decide" snapshotAt={null}><main className="page dk-page">
    <header className="dk-top">
      <div className="dk-title">
        <h1>Decide</h1>
        {items && total > 0 && <p className="dk-count num" aria-live="polite"><b>{left.length}</b> left{decided > 0 && <span> · {decided} of {total} decided</span>}</p>}
      </div>
      <div className="dk-top-actions">
        <button type="button" className="btn small" onClick={() => help.current?.showModal()}><kbd>?</kbd> Shortcuts</button>
        <Link href="/" className="btn small">Back to queue <kbd>Esc</kbd></Link>
      </div>
      {items && total > 0 && <div className="dk-bar" role="progressbar" aria-label="Decided" aria-valuemin={0} aria-valuemax={total} aria-valuenow={decided}><span style={{ width: `${(decided / total) * 100}%` }} /></div>}
    </header>

    {error && <p className="board-error" role="alert">{error}. Check that the app and database are running.</p>}
    {!items && !error && <div aria-busy="true" aria-label="Loading"><div className="q-skel tall" /><div className="q-skel" /><p className="empty">Lining up what needs you…</p></div>}

    {status && left.length > 0 && <p className={`dk-status tone-${status.tone}`} role="status">{status.text}</p>}

    {items && !left.length && <AllDone total={total} done={done} reviewed={reviewedCount} empty={total === 0} />}

    {batch && <BatchView proposals={batch.proposals} stories={batch.stories} byId={byId} excluded={batch.excluded} results={batch.results} busy={batch.busy}
      onToggle={(pid) => setBatch((b) => b && { ...b, excluded: new Set(b.excluded.has(pid) ? [...b.excluded].filter((x) => x !== pid) : [...b.excluded, pid]) })}
      onAccept={acceptBatch} onClose={() => setBatch(null)} />}

    {!batch && q && <>
      <p className="dk-ringo"><RingoFace size={32} /><span>{safety ? "This one is on the road. A person owns it; I stay off the line."
        : pending.length ? "I wrote this one up. Your call."
          : q.reason === "RECORDED_PROPOSAL" ? "Recorded before my time. You do this one by hand."
            : "One at a time. I keep the rest parked."}</span></p>

      {offer && <div className="dk-offer">
        <span><b>{offer.length} similar proposals</b>: {offer[0].actionType ? ACTION[offer[0].actionType] : offer[0].command}, same fields, same reviewer check.</span>
        <button type="button" className="btn" onClick={openBatch}>Review {offer.length} similar together <kbd>B</kbd></button>
      </div>}

      <article className={`dk-card${safety ? " is-safety" : ""}`} ref={card} tabIndex={-1} aria-label={`${q.reference}: ${q.why}`}>
        <div className="dk-card-head">
          <span><span className="mono">{q.reference}</span> · {q.vehicle} · {q.route}</span>
          <span className="dk-card-tags">
            {nextAction(q) && <span className="q-next">{nextAction(q)}</span>}
            <DueTag item={q} now={cur?.story.now ?? now} />
          </span>
        </div>
        {!cur && !loadError[id] && <div aria-busy="true"><div className="q-skel tall" /><p className="empty">Opening {q.reference}…</p></div>}
        {loadError[id] && <p className="result tone-danger" role="alert">{loadError[id]}. <button type="button" className="link-btn" onClick={() => { setLoadError((m) => { const n = { ...m }; delete n[id]; return n }) }}>Try again</button></p>}
        {cur && <>
          <DecisionPanel story={cur.story} ctx={heroContext(cur.detail)} onChanged={() => reviewed(id)} orderHref={`/orders/${id}`} />
          <Facts story={cur.story} />
        </>}
      </article>

      <nav className="dk-nav" aria-label="Decide">
        {cur && !pending.length && <button type="button" className="btn" onClick={take}><Icon name="check" size={14} />I&apos;ll handle it <kbd>A</kbd></button>}
        <button type="button" className="btn" onClick={skip}>Skip <kbd>S</kbd></button>
        <Link className="btn" href={`/orders/${id}`}>Open<span className="dk-wide"> the order</span> <kbd>O</kbd></Link>
        <span className="dk-nav-step">
          <button type="button" className="btn" onClick={() => move(-1)} aria-label="Previous card"><kbd>K</kbd><Icon name="chevron" size={14} className="dk-flip" /><span className="dk-wide">Previous</span></button>
          <button type="button" className="btn" onClick={() => move(1)} aria-label="Next card"><span className="dk-wide">Next</span><Icon name="chevron" size={14} /><kbd>J</kbd></button>
        </span>
      </nav>
    </>}

    <dialog ref={help} className="dk-help" aria-labelledby="dk-help-h" onClick={(e) => { if (e.target === e.currentTarget) help.current?.close() }}>
      <h2 id="dk-help-h">Shortcuts</h2>
      <dl>
        <div><dt><kbd>A</kbd></dt><dd>Accept Ringo&apos;s proposal. With no proposal: I&apos;ll handle it</dd></div>
        <div><dt><kbd>E</kbd></dt><dd>Edit, then say what you changed</dd></div>
        <div><dt><kbd>R</kbd></dt><dd>Reject (a reason is required)</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>Enter</kbd></dt><dd>Send the edit or rejection; <kbd>Esc</kbd> cancels it</dd></div>
        <div><dt><kbd>B</kbd></dt><dd>Review similar proposals together</dd></div>
        <div><dt><kbd>S</kbd></dt><dd>Skip: move this card to the back</dd></div>
        <div><dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Next and previous card</dd></div>
        <div><dt><kbd>O</kbd></dt><dd>Open the full order</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Back to the queue</dd></div>
      </dl>
      <p className="dk-help-note">Every accept, edit and reject is recorded on its proposal, the same as on the order page. &ldquo;I&apos;ll handle it&rdquo; writes nothing.</p>
      <form method="dialog"><button className="btn primary" autoFocus>Close</button></form>
    </dialog>
  </main></AppFrame>
}

function DueTag({ item, now }: { item: QueueItem; now: string }) {
  const rel = relativeTo(item.decideBy, now)
  const urgent = inNow(item, now)
  if (!rel) return urgent ? <span className="chip tone-danger">Now</span> : null
  return <span className={`chip${rel.past && urgent ? " tone-danger" : rel.past ? " tone-warn" : ""} num`}>{rel.past ? `Overdue ${rel.text.replace(/ ago$/, "")}` : <>Due <Ago at={item.decideBy} now={now} /></>}</span>
}

/** The facts that matter: the last words of the driver, customer or site in the past 2 h (who is waiting
 *  on what, in their own words), then triage's chips minus the one that repeats the headline. Each has its source and time. */
function Facts({ story }: { story: OrderStory }) {
  const kinds = new Map(story.timeline.map((e) => [e.ref.id, e.actorKind]))
  const chips = story.triage.chips.filter((f) => f.claim !== story.triage.why)
  const since = Date.parse(story.now) - 2 * 3600_000
  const voices = (["driver", "customer", "site"] as const)
    .map((k) => story.timeline.filter((e) => e.actorKind === k && Date.parse(e.at) >= since).at(-1))
    .filter((e) => !!e).sort((a, b) => b.at.localeCompare(a.at))
  return <section className="dk-facts" aria-labelledby="dk-facts-h">
    <h3 id="dk-facts-h">What matters</h3>
    {voices.length > 0 && <ul className="fact-list dk-voices">{voices.map((e) => <li key={e.ref.id}>
      <p>&ldquo;{e.text}&rdquo;</p>
      <p className="fact-src"><RoleTag role={entryRole(e.actorKind)} />{e.actor}{e.channel ? ` · ${e.channel.replace(/_/g, " ")}` : ""} · <a href={withBase(`/orders/${story.orderId}#src-${e.ref.id}`)}><When at={e.at} now={story.now} /></a></p>
    </li>)}</ul>}
    {chips.length ? <ul className="fact-list">{chips.map((f) => <li key={f.id}><FactChip fact={f} now={story.now} who={factLizard(f, kinds)} /></li>)}</ul>
      : !voices.length && <p className="empty">No facts recorded on this order yet. The records behind the card are linked above.</p>}
  </section>
}

function BatchView({ proposals, stories, byId, excluded, results, busy, onToggle, onAccept, onClose }: {
  proposals: Proposal[]; stories: Record<string, Loaded>; byId: Map<string, QueueItem>; excluded: Set<string>; results: Record<string, { text: string; tone: string }> | null; busy: boolean
  onToggle: (id: string) => void; onAccept: () => void; onClose: () => void
}) {
  const n = proposals.filter((p) => !excluded.has(p.id)).length
  const first = proposals[0]
  const conditions = first?.gate?.findings ?? []
  return <section className="dk-batch" aria-labelledby="dk-batch-h">
    <p className="dk-ringo"><RingoFace size={32} /><span>{results ? "Done. Each one is on its own order's record." : `I've got ${proposals.length} of a kind here. Untick any you'd rather see on its own.`}</span></p>
    <h2 id="dk-batch-h">{first?.actionType ? ACTION[first.actionType] : "Similar proposals"} <span className="dk-batch-n">{proposals.length} orders</span></h2>
    {conditions.length > 0 && <ul className="gate-list">{conditions.map((f) => <li key={f.ruleId}><b>Keep in mind:</b> {f.message}</li>)}</ul>}
    <ul className="dk-batch-list">{proposals.map((p) => {
      const q = byId.get(p.orderId)
      const r = results?.[p.id]
      return <li key={p.id} className={excluded.has(p.id) ? "is-out" : undefined}>
        <label>
          <input type="checkbox" checked={!excluded.has(p.id)} disabled={busy || !!results} onChange={() => onToggle(p.id)} />
          <span className="dk-batch-body">
            <span className="dk-batch-ref"><span className="mono">{q?.reference ?? p.orderId}</span> · {q?.vehicle}</span>
            <span className="dk-batch-sum">{p.summary}</span>
            <span className="dk-batch-pay">{Object.entries(p.proposedPayload).map(([k, v]) => <span key={k}><b>{fieldLabel(k)}:</b> {plain(v)}</span>)}</span>
            {p.onApprove && <span className="dk-batch-then">If you accept: {p.onApprove}</span>}
            <Evidence proposal={p} story={stories[p.orderId]?.story} />
          </span>
        </label>
        {r && <p className={`result tone-${r.tone}`}>{r.text}</p>}
        {results && !r && <p className="result">Left out. It waits on its own card.</p>}
      </li>
    })}</ul>
    <div className="actions">
      {results ? <button type="button" className="btn primary" onClick={onClose} autoFocus>Continue <kbd>Enter</kbd></button> : <>
        <button type="button" className="btn primary" disabled={busy || n === 0} onClick={onAccept}>{busy ? "Accepting…" : `Accept ${n}`} <kbd>A</kbd></button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>One at a time instead <kbd>Esc</kbd></button>
      </>}
    </div>
    <p className="dk-help-note">Sent one by one: each proposal is rechecked against its order and recorded on its own.</p>
  </section>
}

/** What Ringo cites for one proposal, as fact lines with level, source and time (at most 2). */
function Evidence({ proposal: p, story }: { proposal: Proposal; story?: OrderStory }) {
  if (!story) return null
  const refs = new Set(p.evidenceRefs.map((r) => r.id))
  const live = story.facts.filter((f) => !f.supersededByFactId && f.level !== "refuted" && f.level !== "stale")
  const facts = [...live.filter((f) => refs.has(f.sourceId)), ...story.triage.chips].filter((f, i, a) => a.findIndex((x) => x.id === f.id) === i).slice(0, 2)
  if (!facts.length) return null
  const kinds = new Map(story.timeline.map((e) => [e.ref.id, e.actorKind]))
  return <ul className="fact-list inline">{facts.map((f) => <li key={f.id}><FactChip fact={f} now={story.now} who={factLizard(f, kinds)} /></li>)}</ul>
}

function AllDone({ total, done, reviewed, empty }: { total: number; done: Record<string, Done>; reviewed: number; empty: boolean }) {
  const v = Object.values(done)
  const count = (how: Done["how"]) => v.filter((d) => d.how === how).length
  const stale = v.filter((d) => d.stale).length
  const taken = count("TAKEN")
  return <div className="calm dk-done">
    <div className="calm-cast" role="img" aria-label="Ringo with a pickup site, a customer and a driver">{(["ringo", "dealer", "customer", "driver"] as const).map((who) =>
      // eslint-disable-next-line @next/next/no-img-element -- a static svg needs no optimiser
      <img key={who} src={withBase(CAST[who].src)} alt="" width={107} height={120} />)}</div>
    <div>
      <p className="calm-title">{empty ? "Nothing needs you." : "All decided."} Quiet on the lot.</p>
      {!empty && <p className="calm-sub">{[
        reviewed > 0 && `${reviewed} of my ${reviewed === 1 ? "proposal" : "proposals"} reviewed, each one recorded${stale ? ` (${stale} came back stale: nothing changed there)` : ""}`,
        taken > 0 && `${taken} you're handling by hand; they leave Needs you once their records change`,
      ].filter(Boolean).join(". ")}{total ? "." : ""}</p>}
      <p className="dk-done-actions"><Link href="/" className="btn">Back to the queue</Link></p>
    </div>
  </div>
}
