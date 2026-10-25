// After a decision: the step a person owns next, who owns it, and when the order comes back to the queue.
// Pure and client-safe: the "This will" lines (before the press) and the server's result message (after it) share it.
import { fmtClock } from "@/lib/present/time"

/** A decision hands the follow-up to the desk for this long (the order sits in Taken), unless something new happens first. */
export const FOLLOW_UP_MINUTES = 30

export type Names = { customer?: string | null; driver?: string | null }

const VERB = /^(ask|call|email|e-mail|contact|tell|confirm|release|book|check|decide|update|message|find|send|arrange|chase|agree|replan|review|answer|reply|run|accept)\b/i
// "contacts" → "contact", "releases" → "release"; "needs to" → "need to".
const base = (w: string) => /ss$/.test(w) ? w : w.replace(/(ch|sh|x)es$/, "$1").replace(/s$/, "")

/** Ringo's "what next" or the proposal's "if you accept" line, as the person's own step: "ask Pellavaro Auto which
 *  site holds the VIN". Null when the sentence is not a step for a person (e.g. "The driver must call ahead").
 *  ponytail: rewrites Ringo's wording with a few patterns; a structured `personStep` from the model if they misfire. */
export function personStep(text: string | null | undefined, names: Names = {}): string | null {
  if (!text) return null
  let s = (text.match(/^[^.!?]+/)?.[0] ?? text).trim()
  s = s.replace(/^(after|once) (approval|approved|you approve|accepted)[^,]*,\s*/i, "")
  const person = /^(a person|a human|the team|the desk|someone|you)\s+(?:(can|should|must|will|needs? to|has to)\s+)?(\w+)/i.exec(s)
  if (person) s = `${person[2] ? person[3] : base(person[3])}${s.slice(person[0].length)}`
  else if (!VERB.test(s)) return null
  s = s.replace(/,\s*then (\w+)/i, (_, v: string) => `, then ${base(v)}`)
  if (names.customer) s = s.replace(/\bthe customer\b/gi, names.customer)
  if (names.driver) s = s.replace(/\bthe driver\b/gi, names.driver)
  return s.charAt(0).toLowerCase() + s.slice(1)
}

/** Who answering would bring the order back early. */
export function whoReplies(step: string, names: Names = {}): string {
  if (names.customer && step.includes(names.customer)) return `${names.customer} replies`
  if (/\bcustomer\b/i.test(step)) return "the customer replies"
  if (/\b(site|desk|stock control|branch)\b/i.test(step)) return "the site replies"
  if ((names.driver && step.includes(names.driver)) || /\bdriver\b/i.test(step)) return "the driver replies"
  return "something new happens"
}

/** The one desk this control room runs as (the client's DESK). */
export const OWNER = "you (readiness desk)"

/** "Then: you ask Pellavaro Auto which site holds the VIN · owner: you (readiness desk) · back in your queue at 12:40
 *  or when Pellavaro Auto replies". Times are the desk's clock; the page says "Helsinki time" once. */
export function thenLine(step: string, backAt: string, names: Names = {}): string {
  return `Then: you ${step} · owner: ${OWNER} · back in your queue at ${fmtClock(backAt)} or when ${whoReplies(step, names)}`
}

/** The one-line version under a button: "you release driver dispatch, back 12:39". The full thenLine sits behind it. */
export function shortThen(step: string, backAt: string): string {
  const words = step.split(/[,(;]| · /)[0].trim().split(/\s+/)
  return `you ${words.slice(0, 6).join(" ")}${words.length > 6 ? "…" : ""}, back ${fmtClock(backAt)}`
}

/** For a step that keeps the order in the queue (it never leaves): "… · it stays in Now until the recovery is booked". */
export function stayLine(step: string, until: string): string {
  return `Then: you ${step} · owner: ${OWNER} · it stays in Now ${until}`
}

/** The default step when nothing more specific is known. */
export const BY_HAND = "work out the next step by hand"
