// Pure call helpers shared by the phone sim, Ringo's tools and the call UI:
// line language by country, the escalation ladder's stop rules, the phone-menu
// path, and the quote check. No DB, no model, safe to import in the browser.
import type { CallOutcome, CallTurn } from "@/lib/contract"

export type Lang = "en" | "de" | "fi" | "da"
export const LANG_NAME: Record<Lang, string> = { en: "English", de: "German", fi: "Finnish", da: "Danish" }
/** BCP 47 tags for the browser's speech voices. */
export const LANG_TAG: Record<Lang, string> = { en: "en-GB", de: "de-DE", fi: "fi-FI", da: "da-DK" }

/** The language a site answers its phone in. Everything else is English. */
export function langForCountry(country: unknown): Lang {
  return ({ DE: "de", DK: "da", FI: "fi" } as Record<string, Lang>)[String(country ?? "").toUpperCase()] ?? "en"
}

// ---------------------------------------------------------------- the ladder

export type Rung = "site_desk" | "stock_control" | "branch_manager"
export const RUNGS: Rung[] = ["site_desk", "stock_control", "branch_manager"]
export const RUNG_LABEL: Record<Rung, string> = { site_desk: "Site desk", stock_control: "Stock control", branch_manager: "Branch manager" }
export const LADDER = { maxAttemptsPerRung: 2, maxCallsPerRun: 3 }
/** Every ladder refusal starts with this, so the run panel can say why Ringo stopped. */
export const LADDER_STOP = "Ladder stop:"

/** A call turn as Ringo stores it. The extra fields ride along in ring_calls.transcript (jsonb). */
export type Turn = CallTurn & {
  /** Language the line was spoken in. */
  lang?: Lang
  /** English translation of a non-English line (model-made for people, written for the phone menu). */
  en?: string
  /** Who answered (a sim person's name and role, as they introduce themselves). */
  who?: string
  /** Short name of the menu or hold this turn came from, for the path diagram. */
  label?: string
  seconds?: number
  /** First system turn of a call: which rung this call is for, and why Ringo climbed. */
  rung?: Rung
  why?: string
  /** System turn: Ringo started this call from the site's playbook. */
  playbook?: { callId: string; orderId: string; at: string; notes: number }
}

export const callRung = (transcript: CallTurn[]): Rung | null => (transcript as Turn[]).find((t) => t.rung)?.rung ?? null
export const callLang = (transcript: CallTurn[]): Lang => (transcript as Turn[]).find((t) => t.lang && t.speaker !== "system")?.lang ?? "en"

export type LadderCall = { rung: Rung | null; outcome: CallOutcome | null; runId: string }

/**
 * May Ringo place a call to `target` on this order? Returns null when allowed, else the reason
 * (starting with LADDER_STOP). Rules: start at the desk or stock control, never at the manager;
 * climb one rung at a time and say why; at most 2 attempts per rung; at most 3 calls per run;
 * only while the site is open; never climb on a safety case.
 */
export function ladderCheck(input: {
  target: Rung; why?: string | null; prior: LadderCall[]; runId: string; open: boolean; hoursText: string; safety: boolean
}): string | null {
  const t = RUNGS.indexOf(input.target)
  if (t < 0) return `${LADDER_STOP} "${input.target}" is not a rung. Use site_desk, stock_control or branch_manager.`
  if (!input.open) return `${LADDER_STOP} the site is closed right now (${input.hoursText}). I don't ring a closed site; schedule a callback in opening hours.`
  const tried = input.prior.filter((c) => c.rung).map((c) => RUNGS.indexOf(c.rung!))
  const top = tried.length ? Math.max(...tried) : -1
  if (input.safety && t > 0) return `${LADDER_STOP} this is a safety case. I don't climb the ladder on safety; a person owns it.`
  if (input.prior.filter((c) => c.runId === input.runId).length >= LADDER.maxCallsPerRun) return `${LADDER_STOP} ${LADDER.maxCallsPerRun} calls in one run is my limit. Stop and hand over what you have.`
  const attempts = input.prior.filter((c) => c.rung === input.target).length
  if (attempts >= LADDER.maxAttemptsPerRung) return `${LADDER_STOP} ${RUNG_LABEL[input.target].toLowerCase()} has had ${attempts} calls on this order. No third try; a person decides what next.`
  if (top < 0 && t === 2) return `${LADDER_STOP} I never start at the branch manager. Start at the site desk or stock control.`
  if (t > Math.max(top, 0) + 1) return `${LADDER_STOP} one rung at a time. Try ${RUNG_LABEL[RUNGS[top + 1]].toLowerCase()} first.`
  if (t > top && top >= 0 && !input.why?.trim()) return `${LADDER_STOP} climbing to ${RUNG_LABEL[input.target].toLowerCase()} needs a reason: say what the rung below couldn't answer.`
  return null
}

// ---------------------------------------------------------------- phone-menu path

export type PathStep = { kind: "menu" | "press" | "hold" | "person" | "voicemail" | "dropped" | "closed"; text: string }

/** "Main menu → 3 → Collections → 2 → hold 35 s → Stock control → Ilona Alderbrook", from the transcript. */
export function pathOf(transcript: CallTurn[]): PathStep[] {
  const out: PathStep[] = []
  let person = false
  for (const t of transcript as Turn[]) {
    if (t.speaker === "ring" && t.dtmf) out.push({ kind: "press", text: t.dtmf })
    else if (t.heard === "menu" && t.label && out.at(-1)?.text !== t.label) out.push({ kind: "menu", text: t.label })
    else if (t.heard === "hold") out.push({ kind: "hold", text: `hold ${t.seconds ?? "?"} s` })
    else if (t.heard === "voicemail" && out.at(-1)?.kind !== "voicemail") out.push({ kind: "voicemail", text: "voicemail" })
    else if (t.heard === "dropped") out.push({ kind: "dropped", text: "line dropped" })
    else if (t.heard === "closed") out.push({ kind: "closed", text: "closed" })
    else if (t.speaker === "site" && !person) {
      person = true
      if (t.label) out.push({ kind: "menu", text: t.label })
      out.push({ kind: "person", text: t.who ?? "a person" })
    }
  }
  return out
}

export const pathText = (steps: PathStep[]) => steps.map((s) => (s.kind === "press" ? `press ${s.text}` : s.text)).join(" → ")

// ---------------------------------------------------------------- quotes

const norm = (s: string) => s.toLowerCase().normalize("NFC").replace(/[“”„"«»‚‘’']/g, "").replace(/\s+/g, " ").replace(/^[\s.,;:!?…-]+|[\s.,;:!?…-]+$/g, "").trim()

/** The site turn that contains `quote` word for word (case, quotes and spacing aside), or null. */
export function findQuote(quote: string, transcript: CallTurn[]): Turn | null {
  const q = norm(quote)
  if (q.length < 3) return null
  return (transcript as Turn[]).find((t) => t.speaker === "site" && norm(t.text).includes(q)) ?? null
}

/** Speech gate on a line Ringo wants to say: run the rules on the words and on their English translation. */
export function checkBoth(check: (s: string) => string | null, said: string, english: string | null): string | null {
  return check(said) ?? (english ? check(english) : null)
}

// ---------------------------------------------------------------- playbooks

export type PlaybookTopic = "phone_path" | "people" | "keys" | "handover" | "hours" | "quirk"
export const PLAYBOOK_TOPICS: { id: PlaybookTopic; label: string }[] = [
  { id: "phone_path", label: "Phone menu" }, { id: "people", label: "Who answers" }, { id: "keys", label: "Keys" },
  { id: "handover", label: "Handover" }, { id: "hours", label: "Hours" }, { id: "quirk", label: "Quirks" },
]
/** Topics Ringo writes from what was said; the phone path (and a dropped line) is written by code from what happened. */
export const SAID_TOPICS: PlaybookTopic[] = ["people", "keys", "handover", "hours", "quirk"]

/** One playbook note as the API and the UI see it. */
export type PlaybookEntry = {
  id: string; siteId: string; topic: PlaybookTopic; rung: Rung | null; note: string; quote: string | null; language: Lang | null
  level: "quoted" | "observed"; sourceCallId: string; orderId: string; orderRef: string | null; sourceAt: string; createdAt: string
  editedBy: string | null; editedAt: string | null
}
