// "What we know" and Decide's "What matters" in the order the decision needs them. Pure and client-safe:
// the server ranks a story's facts with rankByDecision(), and both screens take the top of that one list.
import type { Fact } from "@/lib/contract"

/** What the hero's decision is about: its words (why, the one decision, Ringo's headline and proposal summaries)
 *  and the records it cites (triage sources, proposal evidence, the facts Ringo's stop names). */
export type DecisionFocus = { text: string; cited: Set<string>; preCollection: boolean }

// Words in the decision → the fact subjects that answer them. ponytail: a keyword table over the decision text;
// a per-reason subject list if the dataset's wording drifts.
const TOPICS: [RegExp, RegExp][] = [
  [/\b(roadside|tow|recovery|warning|safe|stopped)\b/i, /^(alert\.safety|incident\.)/],
  [/\b(location|where|position|service.area)\b/i, /^(incident\.location|car\.position|car\.location|alert\.tracking)/],
  [/\bcustomer\b/i, /^(incident\.recovery|claim\.)/],
  [/\b(VIN|car (is )?not|which site|holds? the|stock|transfer)\b/i, /^(car\.|alert\.empty_pickup|claim\.)/],
  [/\b(keys?|key holder|access|bay|gate|reception|handover)\b/i, /^(pickup\.(access|key|handover)|claim\.)/],
  [/\b(contact|e-?mail|phone|release desk)\b/i, /\.contact$/],
  [/\baddress\b/i, /(address|access_route)$/],
  [/\b(release|seller hold|authority)\b/i, /release/],
  [/\b(proof|pickup photos|handover record|wrong-car)\b/i, /^proof\./],
  [/\b(ferry|crossing|terminal|booking)\b/i, /^(travel|alert\.ferry)/],
  [/\b(promise|delivery window)\b/i, /^(delivery\.promise|alert\.delivery_promise)/],
  [/\bslot\b/i, /^pickup\.slot/],
  [/\bdriver\b/i, /^(driver\.|alert\.empty_pickup)/],
]
// Contacts and photos are background unless the decision names them: they fold under "Show more".
const BACKGROUND = /(\.contact$|^proof\.)/

/** 0 cited by the decision · 1 answers a word in it · 2 an open alert · 3 the order's stage · 4 the rest · 5 background. */
export function relevance(f: Fact, d: DecisionFocus): number {
  if (d.cited.has(f.sourceId) || d.cited.has(f.id)) return 0
  if (TOPICS.some(([words, subjects]) => words.test(d.text) && subjects.test(f.subject))) return 1
  if (BACKGROUND.test(f.subject)) return 5
  if (f.subject.startsWith("alert.")) return 2
  const stage = d.preCollection ? /^(pickup|claim|driver|car)\./ : /^(car|delivery|driver|incident)\./
  return stage.test(f.subject) ? 3 : 4
}

/** Facts in decision order; newest first inside each tier. */
export function rankByDecision(facts: Fact[], d: DecisionFocus): Fact[] {
  return [...facts].sort((x, y) => relevance(x, d) - relevance(y, d) || y.at.localeCompare(x.at))
}

/** What is still true: not superseded, refuted, stale or overtaken. Both screens lead with the first of these. */
export function currentFacts(facts: Fact[], overtaken: Set<string> = new Set()): Fact[] {
  return facts.filter((f) => !f.supersededByFactId && f.level !== "refuted" && f.level !== "stale" && !overtaken.has(f.sourceId))
}

type Open = { status: string; origin?: string; evidenceRefs: { id: string }[] }

/** The facts an open Ringo proposal rests on: the ones whose source record its evidence cites (a call, a message).
 *  Superseded or refuted ones never count. A quote that only aged past 2 h still does: it is what the proposal was
 *  written from, so it leads with its aged level shown, rather than vanishing. */
export function basisFacts(facts: Fact[], proposals: Open[]): Fact[] {
  const open = proposals.filter((p) => p.status === "PENDING_REVIEW" && p.origin !== "dataset")
  if (!open.length) return []
  const cited = new Set(open.flatMap((p) => p.evidenceRefs.map((r) => r.id)))
  return facts.filter((f) => !f.supersededByFactId && f.level !== "refuted" && cited.has(f.sourceId))
}

/** "What we know" and Decide's "What matters": the open proposal's basis first, then what is still true, in decision order. */
export function leadFacts(facts: Fact[], basis: Fact[], overtaken: Set<string> = new Set()): Fact[] {
  const ids = new Set(basis.map((f) => f.id))
  return [...basis, ...currentFacts(facts, overtaken).filter((f) => !ids.has(f.id))]
}
