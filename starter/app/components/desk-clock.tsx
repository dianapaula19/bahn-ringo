"use client"
// The sidebar's desk clock and data-as-of line, on every page. Pages that already loaded the clock pass it in;
// the rest ask /api/agent/clock once a minute (kept between pages so the line doesn't flicker).
import { useEffect, useState } from "react"
import { withBase } from "@/lib/base"
import { fmtDateTime } from "@/lib/present/time"

type Clock = { now: string; snapshotAt: string }
let cache: { at: number; data: Clock } | null = null

export function DeskClock({ now, snapshotAt }: { now?: string | null; snapshotAt?: string | null }) {
  const [clock, setClock] = useState<Clock | null>(() => cache?.data ?? null)
  useEffect(() => {
    if (now || (cache && Date.now() - cache.at < 60_000)) return
    const c = new AbortController()
    fetch(withBase("/api/agent/clock"), { signal: c.signal, cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d: Clock | null) => { if (d) { cache = { at: Date.now(), data: d }; setClock(d) } }).catch(() => {})
    return () => c.abort()
  }, [now])
  const at = now ?? clock?.now
  const as = snapshotAt ?? clock?.snapshotAt
  if (!at && !as) return <p className="desk-clock" aria-busy="true">Reading the desk clock…</p>
  return <p className="desk-clock">Helsinki time<br />{at && <>Desk clock {fmtDateTime(at, null, false)} (simulated)<br /></>}{as && <>Data as of {fmtDateTime(as, null, false)}</>}</p>
}
