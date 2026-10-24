"use client"

import { useCallback, useEffect, useState } from "react"
import posthog from "posthog-js"
import type { TrustLedger, TrustMode, TrustRow } from "@/lib/contract"
import { loadTrust, updateTrust } from "../_lib/agent-api"
import { AppFrame } from "../components/app-frame"
import { Icon } from "../components/icons"
import { ACTION, MODE, When } from "../components/ring/bits"

const GROUPS: { mode: TrustMode; title: string; note: string }[] = [
  { mode: "auto", title: "Ring does these on its own", note: "Asking and looking things up. Nothing changes on the order." },
  { mode: "ask", title: "Ring asks a person first", note: "Ring prepares it; a person accepts, edits or rejects." },
  { mode: "never", title: "Ring never does these", note: "Not even with approval." },
]

export default function TrustPage() {
  const [ledger, setLedger] = useState<TrustLedger | null>(null)
  const [error, setError] = useState("")
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback((signal?: AbortSignal) => loadTrust(signal)
    .then((data) => { setLedger(data); setError("") })
    .catch((e: unknown) => { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Could not load") }), [])
  useEffect(() => { const c = new AbortController(); refresh(c.signal); return () => c.abort() }, [refresh])

  async function change(row: TrustRow, mode: TrustMode) {
    setBusy(row.actionType)
    const r = await updateTrust(row.actionType, mode, mode === "auto" ? "Promoted after a clean review record" : "Moved back to ask first")
    setBusy(null)
    if (!("error" in r)) {
      posthog.capture("trust_mode_updated", {
        action_type: row.actionType,
        previous_mode: row.mode,
        mode: r.row.mode,
      })
    }
    setMsg("error" in r ? r.error : `${ACTION[row.actionType]}: now “${MODE[r.row.mode].label}”.`)
    refresh()
  }

  return <AppFrame section="trust"><main className="page">
    <h1 className="page-title small">What Ring may do</h1>
    <p className="intro">Ring earns trust one kind of action at a time. When a person has accepted five in a row without changes, you can let Ring do that kind on its own. Bookings, dates, costs, address changes and anything sent to a customer always need a person.</p>
    {error && <p className="board-error" role="alert">{error}.</p>}
    {msg && <p className="result tone-ok" role="status">{msg}</p>}
    {!ledger && !error && <div aria-busy="true">{[0, 1, 2].map((i) => <div className="q-skel" key={i} />)}</div>}
    {ledger && ledger.rows.length === 0 && <p className="empty">No rules yet.</p>}
    {ledger && GROUPS.map((g) => {
      const rows = ledger.rows.filter((r) => r.mode === g.mode)
      return <section className="sec" key={g.mode} aria-labelledby={`t-${g.mode}`}>
        <div className="sec-head"><h2 id={`t-${g.mode}`}>{g.title}</h2><span className="count num">{rows.length || ""}</span><span className="note">{g.note}</span></div>
        {rows.length === 0 ? <p className="empty">None.</p> : <ul className="trust-list">{rows.map((r) => <li key={r.actionType} className="trust-row">
          <div className="trust-main">
            <p className="trust-name">{ACTION[r.actionType]}{r.locked && <span className="chip tone-neutral" title={r.lockedReason ?? "Locked"}><Icon name="key" size={12} />Locked</span>}</p>
            <p className="trust-sub">{r.locked ? (r.lockedReason ?? "Always needs a person.")
              : g.mode === "ask" ? (r.promotable ? "Clean record: ready to hand over to Ring." : "Needs five accepted-as-is reviews in a row before Ring can do it alone.")
              : r.updatedAt === ledger.now ? "Default setting." : <>Set <When at={r.updatedAt} now={ledger.now} /></>}</p>
          </div>
          {r.approvedUnchanged + r.edited + r.rejected === 0 ? <span className="trust-none">No reviews yet</span> : <dl className="trust-counts">
            <div><dt>Accepted as is</dt><dd className="num">{r.approvedUnchanged}</dd></div>
            <div><dt>Edited</dt><dd className="num">{r.edited}</dd></div>
            <div><dt>Rejected</dt><dd className="num">{r.rejected}</dd></div>
          </dl>}
          <div className="trust-act">
            {!r.locked && r.mode === "ask" && r.promotable && <button type="button" className="btn primary" disabled={busy === r.actionType} onClick={() => change(r, "auto")}>Let Ring do it</button>}
            {!r.locked && r.mode === "auto" && <button type="button" className="btn" disabled={busy === r.actionType} onClick={() => change(r, "ask")}>Ask me first</button>}
          </div>
        </li>)}</ul>}
      </section>
    })}
  </main></AppFrame>
}
