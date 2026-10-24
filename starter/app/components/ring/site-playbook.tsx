"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { withBase } from "@/lib/base"
import { LANG_NAME, PLAYBOOK_TOPICS, RUNG_LABEL, type PlaybookEntry } from "@/lib/agent/sim/calls"
import { DESK } from "../../_lib/agent-api"
import { RingoFace } from "../ringo"
import { Level, Simulated, When } from "./bits"

type Playbook = { now: string; siteId: string; entries: PlaybookEntry[] }

/** The site page's playbook: what Ringo learned on earlier calls here. A person can fix or remove any note. */
export function SitePlaybook({ siteId }: { siteId: string }) {
  const [data, setData] = useState<Playbook | null>(null)
  const [error, setError] = useState("")
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const c = new AbortController()
    fetch(withBase(`/api/agent/sites/${encodeURIComponent(siteId)}/playbook`), { signal: c.signal, cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<Playbook> })
      .then((d) => { setData(d); setError("") })
      .catch(() => { if (!c.signal.aborted) setError("Couldn't load the playbook.") })
    return () => c.abort()
  }, [siteId, tick])

  const groups = PLAYBOOK_TOPICS.map((t) => ({ ...t, entries: data?.entries.filter((e) => e.topic === t.id) ?? [] })).filter((g) => g.entries.length)
  return <section className="sec playbook" id="playbook" aria-labelledby="playbook-h">
    <div className="sec-head"><h2 id="playbook-h">Ringo&apos;s playbook</h2>{data && data.entries.length > 0 && <span className="count num">{data.entries.length}</span>}
      <Simulated>From simulated calls</Simulated>
      <span className="note">What earlier calls taught about this site. Each note names the call it came from. Fix or remove anything that&apos;s wrong.</span></div>
    {error && <p className="board-error" role="alert">{error}</p>}
    {!data && !error && <p className="empty" aria-busy="true">Loading…</p>}
    {data && data.entries.length === 0 && <p className="playbook-empty"><RingoFace size={32} /><span>Nothing on file yet. After my first call here I&apos;ll write down the menu path, who picked up and where the keys live.</span></p>}
    {groups.map((g) => <div key={g.id} className="playbook-group">
      <h3>{g.label}</h3>
      <ul className="playbook-list">{g.entries.map((e) => <Note key={e.id} entry={e} now={data!.now} onChanged={() => setTick((t) => t + 1)} />)}</ul>
    </div>)}
  </section>
}

function Note({ entry: e, now, onChanged }: { entry: PlaybookEntry; now: string; onChanged: () => void }) {
  const [mode, setMode] = useState<"idle" | "edit" | "delete">("idle")
  const [draft, setDraft] = useState(e.note)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState("")

  async function send(method: "PATCH" | "DELETE") {
    setBusy(true); setMsg("")
    const r = await fetch(withBase(`/api/agent/playbook/${encodeURIComponent(e.id)}`), {
      method, headers: { "content-type": "application/json" }, body: method === "PATCH" ? JSON.stringify({ note: draft, editedBy: DESK }) : undefined,
    }).catch(() => null)
    setBusy(false)
    const body = await r?.json().catch(() => null)
    if (!r?.ok) { setMsg(body?.error ?? "That didn't go through. Try again."); return }
    setMode("idle"); onChanged()
  }

  return <li className="playbook-note">
    <Level level={e.level} />
    <div className="playbook-body">
      {mode === "edit" ? <label className="field"><span className="sr-only">Note</span>
        <textarea rows={2} value={draft} maxLength={300} onChange={(x) => setDraft(x.target.value)} autoFocus /></label>
        : <p className="playbook-text">{e.note}</p>}
      {e.quote && <p className="fact-quote" lang={e.language ?? undefined}>“{e.quote}”{e.language && e.language !== "en" && <> ({LANG_NAME[e.language]})</>}</p>}
      <p className="fact-src">
        {e.level === "observed" ? "Seen on the line" : "Said on the call"}{e.rung && <> · {RUNG_LABEL[e.rung].toLowerCase()}</>} · <Link className="nowrap" href={`/orders/${e.orderId}#src-${e.sourceCallId}`}>Ringo call{e.orderRef ? ` for ${e.orderRef}` : ""}</Link> · <When at={e.sourceAt} now={now} zone />
        {e.editedBy && e.editedAt && <> · edited by {e.editedBy.replace(/-/g, " ")}, <When at={e.editedAt} now={now} zone /></>}
      </p>

      {mode === "edit" && <div className="actions"><button type="button" className="btn primary small" disabled={busy || !draft.trim() || draft.trim() === e.note} onClick={() => send("PATCH")}>Save</button>
        <button type="button" className="btn small" disabled={busy} onClick={() => { setMode("idle"); setMsg("") }}>Cancel</button></div>}
      {mode === "delete" && <div className="actions"><span className="playbook-confirm">Delete this note? Ringo won&apos;t use it on the next call.</span>
        <button type="button" className="btn danger small" disabled={busy} onClick={() => send("DELETE")}>Delete</button>
        <button type="button" className="btn small" disabled={busy} onClick={() => setMode("idle")}>Keep it</button></div>}
      {msg && <p className="result tone-danger" role="alert">{msg}</p>}
    </div>
    {mode === "idle" && <div className="playbook-actions">
      <button type="button" className="link-btn" onClick={() => { setDraft(e.note); setMode("edit") }}>Edit<span className="sr-only"> note</span></button>
      <button type="button" className="link-btn" onClick={() => setMode("delete")}>Delete<span className="sr-only"> note</span></button>
    </div>}
  </li>
}
