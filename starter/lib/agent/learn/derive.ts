// Ringo learns from your edits. Pure, deterministic code, no model:
//   correction keys   EDITED → one per changed field: edit|<actionType>|<field>
//                     REJECTED → one per review:      reject|<actionType>|<reason class>
//   derive()          ≥2 corrections on one key → a rule spec the gate can check, or null when
//                     nothing checkable is common to them (then Ringo keeps quiet and keeps asking)
//   violation()       the spec as a gate predicate
// Self-check: scripts/eval-learned.ts.
import type { ActionType } from "@/lib/contract"
import { rows, type Bundle } from "@/lib/present/bundle"
import { payloadText } from "../caselaw"
import type { LearnedSpec } from "./types"

export const MIN_CORRECTIONS = 2

export type CorrectionLite = {
  id: string; proposalId: string; actionType: ActionType; kind: "edit" | "reject"
  field: string | null; before: unknown; after: unknown; reasonClass: string | null; situation: string[]
}

// ---------------------------------------------------------------- words

type Tok = { n: string; o: string }
const tokens = (s: string): Tok[] =>
  s.split(/\s+/).map((o) => ({ o, n: o.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") })).filter((t) => t.n)
const seq = (t: Tok[]) => ` ${t.map((x) => x.n).join(" ")} `
const show = (t: Tok[]) => t.map((x) => x.o).join(" ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")

/** Does `text` contain `phrase` as whole words, ignoring case and punctuation? */
export const hasPhrase = (text: string, phrase: string) => seq(tokens(text)).includes(seq(tokens(phrase)))

/** Word-level diff (LCS): the runs of words added and removed. Texts here are a sentence or two. */
export function wordDiff(before: string, after: string): { added: Tok[][]; removed: Tok[][] } {
  const x = tokens(before), y = tokens(after)
  const L = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
    L[i][j] = x[i].n === y[j].n ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const added: Tok[][] = [], removed: Tok[][] = []
  let i = 0, j = 0, add: Tok[] = [], rem: Tok[] = []
  const flush = () => { if (add.length) added.push(add); if (rem.length) removed.push(rem); add = []; rem = [] }
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i].n === y[j].n) { flush(); i++; j++ }
    else if (j < y.length && (i >= x.length || L[i][j + 1] >= L[i + 1][j])) add.push(y[j++])
    else rem.push(x[i++])
  }
  flush()
  return { added, removed }
}

/** The longest run of words that every correction added (or removed). "the" or "and" alone teach nothing. */
function commonPhrase(perCorrection: Tok[][][]): string | null {
  const [first, ...rest] = perCorrection
  const cands: Tok[][] = []
  for (const run of first ?? []) for (let a = 0; a < run.length; a++) for (let b = a + 1; b <= run.length; b++) cands.push(run.slice(a, b))
  cands.sort((p, q) => q.length - p.length)
  for (const c of cands) {
    if (!c.some((t) => t.n.length >= 4) || (c.length === 1 && c[0].n.length < 5)) continue
    if (rest.every((runs) => runs.some((r) => seq(r).includes(seq(c))))) return show(c)
  }
  return null
}

// ---------------------------------------------------------------- reasons and situations

/** Reject notes sorted into a few classes by plain keywords. "other" is never learned from. */
export const REASONS: Record<string, { test: RegExp; says: string }> = {
  customer_first: { test: /\b(customer|client|buyer|owner)\b/i, says: "the customer has to decide first" },
  unverified: { test: /\b(unverified|not verified|not confirmed|unconfirmed|no proof|no evidence|no source)\b/i, says: "it rested on something nobody had checked" },
  already_known: { test: /\b(already|duplicate|on file|we have)\b/i, says: "it was already on file" },
  wrong_target: { test: /\b(wrong|not the right)\b/i, says: "it was aimed at the wrong person or place" },
  too_early: { test: /\b(too early|not yet|premature)\b/i, says: "it was too early" },
}
export const reasonClass = (note: string) => Object.entries(REASONS).find(([, r]) => r.test.test(note))?.[0] ?? "other"

/** What is open on the order: alert signals and work item kinds. Learned rules can be scoped to it. */
export function situationOf(b: Bundle): string[] {
  const alerts = b.alerts.filter((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED").map((a) => a.signal)
  const items = rows(b, "work_items").filter((w) => w.details.status === "OPEN" || w.details.status === "NEEDS_EXTERNAL_INPUT").map((w) => String(w.details.kind))
  return [...new Set([...alerts, ...items])].sort()
}

export const patternKey = (c: Pick<CorrectionLite, "kind" | "actionType" | "field" | "reasonClass">) =>
  c.kind === "edit" ? `edit|${c.actionType}|${c.field}` : `reject|${c.actionType}|${c.reasonClass}`

// ---------------------------------------------------------------- words Ringo uses

const NOUN: Partial<Record<ActionType, string>> = {
  "endpoint.record_access": "access instruction", "endpoint.record_contact": "contact record", "driver.instruct": "driver instruction",
  "pickup.hold": "pickup hold", "address.update": "address change", "customer.message": "customer message draft",
}
/** The field that IS the action ("my access instruction", not "the access instruction on my access instruction"). */
const MAIN: Partial<Record<ActionType, string>> = { "endpoint.record_access": "access_instruction", "driver.instruct": "message", "pickup.hold": "reason" }
const human = (k: string) => k.replace(/[_.]/g, " ").toLowerCase()
const noun = (a: ActionType) => NOUN[a] ?? human(a)
const plainValue = (v: unknown) => v === true ? "Yes" : v === false ? "No" : Array.isArray(v) ? v.join(", ") : String(v)
const short = (s: string) => (s.length <= 40 ? s : `${s.slice(0, 40).replace(/\s+\S*$/, "")}…`)
const scope = (s: string[]) => (s.length ? ` on orders flagged ${s.map((x) => `“${human(x)}”`).join(" and ")}` : "")
const fieldLabel = (spec: LearnedSpec) => (!spec.field || spec.field === MAIN[spec.actionType] ? noun(spec.actionType) : human(spec.field))
const SERIOUS = /SAFETY|VEHICLE_WARNING|ACCIDENT|INJUR|BREAKDOWN/

// ---------------------------------------------------------------- the rule as a gate predicate

/** Why this proposal breaks the learned rule, or null. */
export function violation(spec: LearnedSpec, p: { actionType: string | null; payload: Record<string, unknown> }, situation: string[]): string | null {
  if (p.actionType !== spec.actionType) return null
  if (!spec.situation.every((s) => situation.includes(s))) return null
  if (!spec.field) return `A person decides this one${scope(spec.situation)}; don't propose a ${noun(spec.actionType)} (learned from your rejections).`
  const v = p.payload[spec.field]
  if (spec.equals !== undefined) return v !== undefined && JSON.stringify(v) !== JSON.stringify(spec.equals) ? `${human(spec.field)} must be ${plainValue(spec.equals)} (learned from your edits).` : null
  const text = payloadText(v)
  if (spec.forbid && hasPhrase(text, spec.forbid)) return `The ${fieldLabel(spec)} must not say “${spec.forbid}”${spec.require ? `; say “${spec.require}”` : ""} (learned from your edits).`
  if (spec.require && !hasPhrase(text, spec.require)) return `The ${fieldLabel(spec)} must include “${spec.require}” (learned from your edits).`
  return null
}

// ---------------------------------------------------------------- derive

export type Draft = { spec: LearnedSpec; title: string; text: string; ask: string }

export function derive(group: CorrectionLite[]): Draft | null {
  if (group.length < MIN_CORRECTIONS) return null
  const c0 = group[0]
  if (group.some((c) => patternKey(c) !== patternKey(c0))) return null
  const situation = c0.situation.filter((s) => group.every((c) => c.situation.includes(s)))
  const base: LearnedSpec = { actionType: c0.actionType, field: c0.field, require: null, forbid: null, situation }
  const candidates: LearnedSpec[] = []
  if (c0.kind === "reject") {
    if (!REASONS[c0.reasonClass ?? ""]) return null
    candidates.push({ ...base, field: null })
  } else if (group.every((c) => typeof c.after === "string" && (c.before == null || typeof c.before === "string"))) {
    const diffs = group.map((c) => wordDiff(String(c.before ?? ""), String(c.after)))
    const require = commonPhrase(diffs.map((d) => d.added)), forbid = commonPhrase(diffs.map((d) => d.removed))
    if (require && forbid) candidates.push({ ...base, require, forbid })
    if (require) candidates.push({ ...base, require })
    if (forbid) candidates.push({ ...base, forbid })
  } else if (group.every((c) => JSON.stringify(c.after) === JSON.stringify(c0.after))) {
    candidates.push({ ...base, equals: c0.after })
  }
  // A rule must block what you corrected and pass what you wrote instead, on every cited review.
  const spec = candidates.find((s) => s.field === null || group.every((c) =>
    violation(s, { actionType: c.actionType, payload: { [c.field!]: c.before } }, c.situation)
    && !violation(s, { actionType: c.actionType, payload: { [c.field!]: c.after } }, c.situation)))
  if (!spec) return null
  return { spec, ...words(spec, group.length, c0.reasonClass, group.some((c) => c.situation.some((s) => SERIOUS.test(s)))) }
}

function words(spec: LearnedSpec, n: number, cls: string | null, serious: boolean): Omit<Draft, "spec"> {
  const a = noun(spec.actionType), sc = scope(spec.situation), f = fieldLabel(spec)
  const where = f === a ? `my ${a}` : `the ${f} on my ${a}`
  // Dry and brief; in a safety case, plain and without the patter.
  const lead = serious ? "You've" : `${n === 2 ? "Twice" : n === 3 ? "Three times" : `${n} times`} now you've`
  const tail = serious ? ` (${n} reviews)` : ""
  const shall = serious ? "Should I" : "Shall I"
  if (!spec.field) return {
    title: `No ${a} without a person${sc ? ", in these cases" : ""}`,
    text: `Ringo does not propose a ${a}${sc}; it brings the decision to a person.`,
    ask: `${lead} turned down my ${a}${sc}${tail}: ${REASONS[cls ?? ""]?.says ?? "same reason"}. ${shall} stop proposing it${sc ? " there" : ""} and bring you the decision instead?`,
  }
  if (spec.equals !== undefined) return {
    title: `${human(spec.field)}: ${plainValue(spec.equals)}`,
    text: `${human(spec.field)} is ${plainValue(spec.equals)} on every ${a}${sc}.`.replace(/^./, (c) => c.toUpperCase()),
    ask: `${lead} set ${human(spec.field)} to ${plainValue(spec.equals)} on my ${a}${sc}${tail}. ${shall} always do that?`,
  }
  const pre = f === a ? `Every ${a}${sc}` : `The ${f} on every ${a}${sc}`
  if (spec.require && spec.forbid) return {
    title: `Say “${short(spec.require)}”`,
    text: `${pre} says “${spec.require}”, not “${spec.forbid}”.`,
    ask: `${lead} changed “${spec.forbid}” to “${spec.require}” in ${where}${sc}${tail}. ${shall} always do that?`,
  }
  if (spec.require) return {
    title: `Include “${short(spec.require)}”`,
    text: `${pre} includes “${spec.require}”.`,
    ask: `${lead} added “${spec.require}” to ${where}${sc}${tail}. ${shall} always put it in?`,
  }
  return {
    title: `Leave out “${short(spec.forbid!)}”`,
    text: `${f === a ? `No ${a}${sc}` : `No ${f} on a ${a}${sc}`} says “${spec.forbid}”.`,
    ask: `${lead} taken “${spec.forbid}” out of ${where}${sc}${tail}. ${shall} stop writing it?`,
  }
}
