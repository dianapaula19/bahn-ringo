"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import type { CallRecord } from "@/lib/contract"
import { callLang, callRung, LANG_NAME, LANG_TAG, pathOf, RUNG_LABEL, RUNGS, type Lang, type Turn } from "@/lib/agent/sim/calls"
import { Simulated, When } from "./bits"

const OUTCOME: Record<string, string> = { ANSWERED: "Answered", NO_ANSWER: "No answer", VOICEMAIL: "Voicemail", CLOSED: "Site closed", DROPPED_UNKNOWN: "Dropped, outcome unknown" }
const SPEAKER = { ivr: "Phone menu", ring: "Ringo", site: "Site", system: "Line" } as const

type CallLike = Pick<CallRecord, "id" | "transcript" | "outcome"> & Partial<Pick<CallRecord, "purpose" | "reconciledFrom" | "siteId">>

/** Preface turns (rung, playbook) are shown in the call's head, not as lines. */
const isMeta = (t: Turn) => t.speaker === "system" && (!!t.rung || !!t.playbook)

export function CallView({ call, now, live = false }: { call: CallLike; now: string | null; live?: boolean }) {
  const turns = call.transcript as Turn[]
  const lines = turns.filter((t) => !isMeta(t))
  const lang = callLang(turns)
  const rung = callRung(turns)
  const why = turns.find((t) => t.rung)?.why
  const playbook = turns.find((t) => t.playbook)?.playbook
  const path = pathOf(turns)
  const bilingual = lang !== "en" || lines.some((t) => t.en)
  const hear = useHear(lines, lang)

  return <div className="call">
    <div className="call-head">
      <Simulated>Simulated call</Simulated>
      {call.purpose && <span className="call-purpose">{call.purpose}</span>}
      {rung && <span className="chip tone-neutral" title="Escalation ladder: site desk, then stock control, then branch manager">{RUNG_LABEL[rung]} · rung {RUNGS.indexOf(rung) + 1} of {RUNGS.length}</span>}
      {lang !== "en" && <span className="chip tone-neutral">{LANG_NAME[lang]}</span>}
      {call.outcome ? <span className={`chip tone-${call.outcome === "ANSWERED" ? "ok" : "warn"}`}>{OUTCOME[call.outcome]}</span> : live ? <span className="chip tone-accent"><span className="chip-dot live-dot" />On the line</span> : null}
      {hear.can && lines.length > 0 && !live && <button type="button" className="btn small" onClick={hear.toggle} aria-pressed={hear.on}>{hear.on ? "Stop" : "Hear it"}</button>}
    </div>
    {playbook && <p className="call-note">Used the playbook from the <Link href={`/orders/${playbook.orderId}#src-${playbook.callId}`}><When at={playbook.at} now={now} /> call</Link> ({playbook.notes} note{playbook.notes === 1 ? "" : "s"}){call.siteId && <>. <Link href={`/sites/${call.siteId}#playbook`}>Site playbook</Link></>}.</p>}
    {why && <p className="call-note"><b>Why this rung:</b> {why.replace(/\.?$/, ".")}</p>}
    {call.reconciledFrom && <p className="call-reconciled"><b>Before redialling, Ringo checked:</b> {call.reconciledFrom.finding}</p>}
    {path.length > 1 && <ol className="ivr-path" aria-label="Phone menu path">{path.map((s, i) => <li key={i} className={`ivr-step k-${s.kind}`}>{s.kind === "press" ? <kbd>{s.text}</kbd> : s.text}</li>)}</ol>}
    {hear.note && <p className="call-note" role="status">{hear.note}</p>}
    {lines.length === 0 && <p className="empty">Dialling…</p>}
    {lines.length > 0 && <ol className={`transcript${bilingual ? " bilingual" : ""}`}>
      {bilingual && <li className="turn turn-cols" aria-hidden="true"><span /><span>Said, in {LANG_NAME[lang]}</span><span>In English <span className="translated">translated</span></span><span /></li>}
      {lines.map((t, i) => <li key={i} className={`turn sp-${t.speaker}${hear.at === i ? " playing" : ""}`} aria-current={hear.at === i ? "true" : undefined}>
        <span className="turn-who">{t.speaker === "site" && t.who ? t.who.split(",")[0] : SPEAKER[t.speaker]}</span>
        <span className="turn-text" lang={t.lang ? LANG_TAG[t.lang] : undefined}>{t.dtmf ? <span className="dtmf">Pressed {t.dtmf}</span> : t.text}</span>
        {bilingual && <span className="turn-en">{t.dtmf ? null : t.en ? <><span className="sr-only">English, translated: </span>{t.en}</> : t.lang && t.lang !== "en" ? <span className="muted">No translation</span> : null}</span>}
        <span className="turn-at"><When at={t.at} now={now} /></span>
      </li>)}
    </ol>}
  </div>
}

// ---------------------------------------------------------------- Hear it

function voicesFor(lang: Lang): SpeechSynthesisVoice[] {
  const all = window.speechSynthesis.getVoices()
  const tag = LANG_TAG[lang].toLowerCase()
  const match = all.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(lang))
  return [...match.filter((v) => v.lang.toLowerCase().replace("_", "-") === tag), ...match.filter((v) => v.lang.toLowerCase().replace("_", "-") !== tag)]
}

const waitForVoices = () => new Promise<void>((done) => {
  if (window.speechSynthesis.getVoices().length) return done()
  const t = setTimeout(done, 800)
  window.speechSynthesis.addEventListener("voiceschanged", () => { clearTimeout(t); done() }, { once: true })
})

/**
 * Opt-in playback, never automatic: two voices in the call's language (Ringo and the site), the
 * line being spoken highlighted. With no voice for that language on this device, it only highlights.
 */
function useHear(lines: Turn[], lang: Lang) {
  const [at, setAt] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [can, setCan] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { setCan(typeof window !== "undefined") }, [])
  const synth = () => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null)
  const stop = () => { synth()?.cancel(); if (timer.current) clearTimeout(timer.current); timer.current = null; setAt(null) }
  useEffect(() => stop, []) // eslint-disable-line react-hooks/exhaustive-deps

  function highlightOnly(i: number) {
    if (i >= lines.length) { setAt(null); return }
    setAt(i)
    timer.current = setTimeout(() => highlightOnly(i + 1), Math.min(6000, Math.max(1200, lines[i].text.length * 55)))
  }

  async function play() {
    const s = synth()
    if (s) await waitForVoices()
    const own = s ? voicesFor(lang) : []
    if (!s || !own.length) {
      setNote(`No ${LANG_NAME[lang]} voice on this device, so I'll follow along on screen instead.`)
      highlightOnly(0)
      return
    }
    setNote(null)
    s.cancel()
    const english = voicesFor("en")
    lines.forEach((t, i) => {
      const u = new SpeechSynthesisUtterance(t.dtmf ? `${t.dtmf}` : t.text)
      const mine = t.lang && t.lang !== lang ? voicesFor(t.lang) : own
      const pool = mine.length ? mine : t.speaker === "system" ? english : own
      // Two voices: the site and the menu take the first, Ringo the second when there is one.
      u.voice = (t.speaker === "ring" ? pool[1] ?? pool[0] : pool[0]) ?? null
      u.lang = u.voice?.lang ?? LANG_TAG[lang]
      u.pitch = t.speaker === "ring" ? (pool.length > 1 ? 1 : 1.2) : t.speaker === "ivr" ? 0.85 : 1
      u.rate = t.speaker === "ivr" ? 0.95 : 1.05
      u.onstart = () => setAt(i)
      if (i === lines.length - 1) u.onend = () => setAt(null)
      s.speak(u)
    })
    setAt(0)
  }

  return { can, on: at !== null, at, note, toggle: () => (at !== null ? stop() : void play()) }
}
