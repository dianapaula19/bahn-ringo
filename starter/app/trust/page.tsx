"use client"

import { useCallback, useEffect, useState } from "react"
import posthog from "posthog-js"
import type { TrustLedger, TrustMode, TrustRow } from "@/lib/contract"
import type { LearnedResponse } from "@/lib/agent/learn/types"
import { loadLearned, loadTrust, updateTrust } from "../_lib/agent-api"
import { AppFrame } from "../components/app-frame"
import { Icon } from "../components/icons"
import { CastLineup, RingoFace } from "../components/ringo"
import { ACTION, MODE, When } from "../components/ring/bits"
import { LearnedRules, Suggestions } from "./learned"

const GROUPS: { mode: TrustMode; title: string; note: string }[] = [
  { mode: "auto", title: "Ringo does these on his own", note: "Asking and looking. Nothing on the order changes." },
  { mode: "ask", title: "Ringo asks a person first", note: "Five accepted as-is in a row, and you can hand it over." },
  { mode: "never", title: "Ringo never does these", note: "Not even with approval." },
]

export default function TrustPage() {
  const [ledger, setLedger] = useState<TrustLedger | null>(null)
  const [error, setError] = useState("")
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [learned, setLearned] = useState<LearnedResponse | null>(null)
  const [learnError, setLearnError] = useState("")

  const refresh = useCallback((signal?: AbortSignal) => Promise.all([
    loadTrust(signal).then((data) => { setLedger(data); setError("") })
      .catch((e: unknown) => { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Could not load") }),
    // Learned rules load on their own: if they fail, the ledger still shows.
    loadLearned(signal).then((data) => { setLearned(data); setLearnError("") })
      .catch((e: unknown) => { if (!signal?.aborted) setLearnError(e instanceof Error ? e.message : "Could not load") }),
  ]), [])
  const learnedFor = (r: TrustRow) => learned?.rules.filter((l) => l.status === "active" && l.actionType === r.actionType).map((l) => l.ruleId) ?? []
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
    <div className="trust-intro"><RingoFace size={64} /><div>
      <h1 className="page-title small">What Ringo may do</h1>
      <p className="intro">Ringo earns trust one action at a time. Bookings, dates, costs, addresses and customer messages always need a person.</p>
    </div></div>
    {learned && <Suggestions rules={learned.rules} now={learned.now} onChanged={() => refresh()} />}
    {/* The crew sits above the rules: at the bottom it was only visible until the rules loaded and pushed it off screen. */}
    <section className="sec crew" id="crew" aria-labelledby="crew-h">
      <div className="sec-head"><h2 id="crew-h">Meet the crew</h2><span className="note">Who said it, at a glance. All fictional.</span></div>
      <CastLineup />
    </section>
    {error && <p className="board-error" role="alert">{error}.</p>}
    {msg && <p className="result tone-ok" role="status">{msg}</p>}
    {!ledger && !error && <div aria-busy="true">{[0, 1, 2].map((i) => <div className="q-skel" key={i} />)}</div>}
    {ledger && ledger.rows.length === 0 && <p className="empty">No rules yet.</p>}
    {ledger && GROUPS.map((g) => {
      const rows = ledger.rows.filter((r) => r.mode === g.mode)
      const reviewed = (r: TrustRow) => r.approvedUnchanged + r.edited + r.rejected > 0
      // Reviews say nothing about "never"; elsewhere "No reviews yet" is said once, not on every row.
      const unreviewed = g.mode !== "never" && rows.length > 0 && !rows.some(reviewed)
      return <section className="sec" key={g.mode} aria-labelledby={`t-${g.mode}`}>
        <div className="sec-head"><h2 id={`t-${g.mode}`}>{g.title}</h2><span className="count num">{rows.length || ""}</span><span className="note">{g.note}{unreviewed && <> No reviews yet.</>}</span></div>
        {rows.length === 0 ? <p className="empty">None.</p> : <ul className="trust-list">{rows.map((r) => <li key={r.actionType} className="trust-row">
          <div className="trust-main">
            <p className="trust-name">{ACTION[r.actionType]}{g.mode === "never" ? <span className="chip tone-neutral" title={r.lockedReason ?? "Never"}><NeverIcon />Never</span>
              : r.locked && <span className="chip tone-neutral" title={r.lockedReason ?? "Locked"}><Icon name="key" size={12} />Always asks</span>}</p>
            {(() => {
              const sub = r.locked ? (r.lockedReason ?? "Always needs a person.")
                : g.mode === "ask" ? (r.promotable ? "Clean record: ready to hand over to Ringo." : null)
                : r.updatedAt === ledger.now ? null : <>Set <When at={r.updatedAt} now={ledger.now} /></>
              return sub && <p className="trust-sub">{sub}</p>
            })()}
            {learnedFor(r).length > 0 && <p className="trust-sub">Checked against what you taught Ringo: <a href="#learned">{learnedFor(r).join(", ")}</a></p>}
          </div>
          {g.mode !== "never" && reviewed(r) ? <dl className="trust-counts">
            <div><dt>Accepted as is</dt><dd className="num">{r.approvedUnchanged}</dd></div>
            <div><dt>Edited</dt><dd className="num">{r.edited}</dd></div>
            <div><dt>Rejected</dt><dd className="num">{r.rejected}</dd></div>
          </dl> : <span />}
          <div className="trust-act">
            {!r.locked && r.mode === "ask" && r.promotable && <button type="button" className="btn primary" disabled={busy === r.actionType} onClick={() => change(r, "auto")}>Let Ringo do it</button>}
            {!r.locked && r.mode === "auto" && <button type="button" className="btn" disabled={busy === r.actionType} onClick={() => change(r, "ask")}>Ask me first</button>}
          </div>
        </li>)}</ul>}
      </section>
    })}
    {learnError ? <section className="sec"><p className="board-error" role="alert">Rules Ringo learned from you: {learnError}.</p></section>
      : !learned ? <section className="sec" aria-busy="true"><div className="q-skel" /></section>
      : <LearnedRules rules={learned.rules} now={learned.now} onChanged={() => refresh()} />}
  </main></AppFrame>
}

/** A circle with a slash: "never", not "locked". */
const NeverIcon = () => <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
  <circle cx="8" cy="8" r="6" /><path d="M3.8 12.2 12.2 3.8" /></svg>
