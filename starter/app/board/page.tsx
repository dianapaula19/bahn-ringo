"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LANES } from "@/lib/present/labels"
import type { Overview } from "@/lib/present/types"
import { loadQueue } from "../_lib/agent-api"
import { AppFrame } from "../components/app-frame"
import { Card } from "../components/card"
import { Icon } from "../components/icons"
import { withBase } from "@/lib/base"

export default function Home() {
  const [search, setSearch] = useState("")
  const [onlyNeeds, setOnlyNeeds] = useState(false)
  const [overview, setOverview] = useState<Overview | null>(null)
  // "Needs you" here is the queue's own list (triage), so the two pages always agree.
  const [needs, setNeeds] = useState<Set<string> | null>(null)
  const [error, setError] = useState("")
  const [stage, setStage] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(withBase(`/api/overview?q=${encodeURIComponent(search)}`), { signal: controller.signal })
        .then((response) => { if (!response.ok) throw new Error("Could not load orders"); return response.json() as Promise<Overview> })
        .then((data) => { setOverview(data); setError("") })
        .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load orders") })
    }, search ? 180 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [search])

  useEffect(() => {
    const c = new AbortController()
    loadQueue(c.signal).then((q) => setNeeds(new Set(q.needsYou.map((i) => i.orderId)))).catch(() => {}) // without it the board still works, minus the filter
    return () => c.abort()
  }, [])

  const visible = useMemo(() => {
    const cards = overview?.visible ?? []
    return onlyNeeds && needs ? cards.filter((card) => needs.has(card.id)) : cards
  }, [overview, onlyNeeds, needs])
  const filtering = !!search || onlyNeeds
  const lanes = LANES.filter(([lane]) => !filtering || visible.some((card) => card.displayLane === lane))
  const shown = lanes.find(([lane]) => lane === stage)?.[0] ?? lanes.find(([lane]) => visible.some((c) => c.displayLane === lane))?.[0] ?? lanes[0]?.[0]
  const needing = (lane: string) => needs ? visible.filter((c) => c.displayLane === lane && needs.has(c.id)).length : 0
  const scroll = useScrollEdges([visible.length, lanes.length])

  return <AppFrame section="board" board snapshotAt={overview?.snapshotAt ?? null}><main className="board-page">
    <div className="board-head">
      <div className="board-title">
        <h1>Orders</h1>
        <p className="board-sub">{overview
          ? <><b>{overview.total}</b> orders · <b>{overview.counts.moving ?? 0}</b> moving{needs && <> · <b>{needs.size}</b> need you</>}</>
          : "Loading the snapshot"}</p>
      </div>
      <div className="board-tools">
        <label className="search">
          <span className="sr-only">Search orders</span>
          <Icon name="search" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Reference, car, plate, customer or city" />
          {search && <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="Clear search"><Icon name="arrow" size={14} style={{ transform: "rotate(45deg)" }} /></button>}
        </label>
        <button type="button" className="toggle" aria-pressed={onlyNeeds} disabled={!needs} onClick={() => setOnlyNeeds((value) => !value)}>
          <Icon name="alert" size={14} /> Needs you{needs ? <b>{needs.size}</b> : null}
        </button>
      </div>
      {lanes.length > 0 && <label className="stage-pick">
        <span className="sr-only">Stage</span>
        <select value={shown} onChange={(e) => setStage(e.target.value)}>
          {lanes.map(([lane, label]) => {
            const n = visible.filter((c) => c.displayLane === lane).length
            const k = needing(lane)
            return <option key={lane} value={lane}>{label} · {n}{k && !onlyNeeds ? ` · ${k} need you` : ""}</option>
          })}
        </select>
        <Icon name="chevron" size={14} className="stage-chev" />
      </label>}
    </div>
    {error && <p className="board-error" role="alert">{error}. Check that the local database is running and seeded.</p>}
    <div className={`board-wrap${scroll.left ? " more-left" : ""}${scroll.right ? " more-right" : ""}`}>
      <section className="board" aria-label="Order lanes" ref={scroll.ref} onScroll={scroll.update}>
        {lanes.map(([lane, label]) => {
          const cards = visible.filter((card) => card.displayLane === lane)
          const total = overview?.counts[lane] ?? 0
          const k = needing(lane)
          return <div className={`lane lane-${lane}${lane === shown ? " on" : ""}`} key={lane}>
            <header className="lane-head">
              <h2>{label}</h2>
              <span className="lane-count num">{filtering ? `${cards.length} of ${total}` : total}</span>
              {k > 0 && !onlyNeeds && <span className="lane-attention num">{k} need you</span>}
            </header>
            <div className="lane-scroll">
              {!overview && !error && <ul className="lane-list" aria-busy="true">{[0, 1, 2].map((index) => <li className="skeleton" key={index} />)}</ul>}
              {overview && cards.length === 0 && <p className="lane-empty">{filtering ? "No matching orders here." : "No orders here."}</p>}
              {cards.length > 0 && <ul className="lane-list">{cards.map((card) => <li key={card.id}><Card card={card} /></li>)}</ul>}
            </div>
          </div>
        })}
        {overview && filtering && visible.length === 0 && <p className="board-empty">
          {search ? <>No orders match “{search}”{onlyNeeds ? " among the ones that need you" : ""}.</> : "Nothing needs you."}
        </p>}
      </section>
      {scroll.left && <button type="button" className="board-step left" aria-label="Earlier stages" onClick={() => scroll.by(-1)}><Icon name="chevron" size={16} style={{ transform: "rotate(180deg)" }} /></button>}
      {scroll.right && <button type="button" className="board-step right" aria-label="Later stages" onClick={() => scroll.by(1)}><Icon name="chevron" size={16} /></button>}
    </div>
  </main></AppFrame>
}

/** Which sides of the lane strip have more lanes off screen, for the edge fades. */
function useScrollEdges(deps: unknown[]) {
  const ref = useRef<HTMLElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 4, right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }))
  }, [])
  useEffect(() => {
    update()
    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  }, [update, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps -- re-measure when the lanes change
  const by = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * 300, behavior: "smooth" })
  return { ref, update, by, ...edges }
}
