"use client"
// Time Ringo saved today, on /trust and /engine only: the measured phone time first, the desk-work estimate apart
// and labelled as one. Reads /engine/savings (formula in lib/savings.ts).
import "./savings.css"
import Link from "next/link"
import { useEffect, useState } from "react"
import { withBase } from "@/lib/base"
import { fmtDay } from "@/lib/present/time"
import { ESTIMATE_LABELS, fmtSaved, fmtSeconds, type Savings, type SavingsEstimates } from "@/lib/savings"
import { Icon } from "./icons"
import { RingoFace } from "./ringo"

// Keep the last answer for a minute so moving between /trust and /engine doesn't flicker.
let cache: { at: number; data: Savings } | null = null

function useSavings(): [Savings | null | "error", (s: Savings) => void] {
  const [data, setData] = useState<Savings | null | "error">(() => cache?.data ?? null)
  useEffect(() => {
    // A save on one reader updates any other on the page.
    const onSaved = () => { if (cache) setData(cache.data) }
    window.addEventListener("ringo-savings", onSaved)
    const c = new AbortController()
    if (!cache || Date.now() - cache.at > 60_000) fetch(withBase("/engine/savings"), { signal: c.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Savings) => { cache = { at: Date.now(), data: d }; setData(d) })
      .catch(() => { if (!c.signal.aborted) setData((d) => d ?? "error") })
    return () => { c.abort(); window.removeEventListener("ringo-savings", onSaved) }
  }, [])
  return [data, (d) => { cache = { at: Date.now(), data: d }; window.dispatchEvent(new Event("ringo-savings")) }]
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const MIN = (n: number) => `${n} min`

/** `edit`: the estimate form (on /trust); /engine shows the numbers only. */
export function SavingsSection({ edit = true }: { edit?: boolean }) {
  const [s, set] = useSavings()
  const [draft, setDraft] = useState<SavingsEstimates | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  // /trust#savings: the ledger above loads after us and pushes this section down; follow it for a moment.
  useEffect(() => {
    if (location.hash !== "#savings") return
    const el = document.getElementById("savings")
    const ro = new ResizeObserver(() => el?.scrollIntoView({ block: "start" }))
    ro.observe(document.body)
    const t = setTimeout(() => ro.disconnect(), 3000)
    return () => { clearTimeout(t); ro.disconnect() }
  }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!draft) return
    setBusy(true)
    const r = await fetch(withBase("/engine/savings"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ estimates: draft }) })
      .then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => null) })).catch(() => ({ ok: false, body: null }))
    setBusy(false)
    if (r.ok && r.body) { set(r.body as Savings); setDraft(null); setMsg({ text: "Saved. The count uses your minutes now.", ok: true }) }
    else setMsg({ text: r.body?.error ?? "Could not save. Nothing changed.", ok: false })
  }

  const head = <div className="sec-head"><h2 id="savings-h">Time Ringo saved</h2>
    {s && s !== "error" && <span className="note">Today, {fmtDay(s.now, "Europe/Helsinki")} (Helsinki). Calls are simulated.</span>}</div>

  if (s === "error") return <section className="sec savings" id="savings" aria-labelledby="savings-h">{head}<p className="board-error" role="alert">Could not count Ringo's time right now.</p></section>
  if (!s) return <section className="sec savings" id="savings" aria-labelledby="savings-h" aria-busy="true">{head}<div className="q-skel tall" /></section>

  const e = s.estimates
  const form = draft ?? e
  return <section className="sec savings" id="savings" aria-labelledby="savings-h">
    {head}
    <div className="savings-card">
      <p className="savings-ringo"><RingoFace size={32} /><span>{s.runs
        ? "I sit through the hold music so you don't have to. Here's today's tab."
        : "Nothing on the tab yet today. When I work an order, the minutes show up here."}</span></p>
      {s.runs > 0 && <p className="savings-total"><span className="savings-big">{fmtSeconds(s.lineSeconds + s.holdSeconds)}</span>
        <span className="savings-sub">measured: on the phone for you, {plural(s.calls, "call")} · {plural(s.runs, "run")}</span></p>}
      <dl className="savings-parts">
        <div><dt>On the line <span className="savings-kind">measured</span></dt>
          <dd>{s.calls ? <>{plural(s.calls, "call")}, {fmtSeconds(s.lineSeconds)}</> : "No calls yet"}</dd></div>
        <div><dt>On hold <span className="savings-kind">measured from the phone menus</span></dt>
          <dd>{s.holdSeconds ? fmtSeconds(s.holdSeconds) : "None"}</dd></div>
      </dl>
      <div className="savings-estimate">
        <p className="savings-estimate-head"><span className="savings-kind estimate">Estimate, not measured</span> Desk work Ringo did that a person would otherwise do: {s.reads + s.driverMessages + s.notes === 0 ? "none yet" : <b>{fmtSaved(s.estimateSeconds)}</b>}</p>
        {s.reads + s.driverMessages + s.notes > 0 && <p className="savings-estimate-sum">{plural(s.reads, "read")} × {MIN(e.readMin)} + {plural(s.driverMessages, "driver message")} × {MIN(e.driverMessageMin)} + {plural(s.notes, "fact")} written × {MIN(e.noteMin)}</p>}
      </div>
      <p className="savings-formula">The measured part is the time Ringo spent on simulated calls and on hold. The estimate counts his reads, driver messages and facts at minutes per step that a person sets on What Ringo may do; they are a guess, so the two are never added into one number.</p>
      {edit && <details className="more savings-edit" onToggle={(ev) => { if (!(ev.currentTarget as HTMLDetailsElement).open) { setDraft(null); setMsg(null) } }}>
        <summary><Icon name="chevron" size={12} />Change the estimate</summary>
        <form onSubmit={save}>
          {(Object.keys(ESTIMATE_LABELS) as (keyof SavingsEstimates)[]).map((k) => <label key={k} className="savings-field">
            <span>{ESTIMATE_LABELS[k]}</span>
            <span className="savings-input"><input type="number" min={0} max={60} step={0.5} required value={form[k]}
              onChange={(ev) => setDraft({ ...form, [k]: ev.target.value === "" ? "" : Number(ev.target.value) } as SavingsEstimates)} /> min</span>
          </label>)}
          <div className="savings-actions"><button type="submit" className="btn" disabled={busy || !draft}>Save minutes</button>
            {draft && <button type="button" className="link-btn" onClick={() => setDraft(null)}>Undo</button>}</div>
        </form>
      </details>}
      {msg && <p className={`result ${msg.ok ? "tone-ok" : "tone-warn"}`} role="status">{msg.text}</p>}
    </div>
  </section>
}
