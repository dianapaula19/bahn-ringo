// Deterministic Reviewer gate: predicates over a proposal, no LLM.
import type { GateFinding, GateResult } from "@/lib/contract"
import { MECHANICAL, RULES, type GateContext, type GateInput } from "./caselaw"

export function runGate(p: GateInput, ctx: GateContext, checkedAt: string, exclude: Set<string> = new Set()): GateResult {
  const findings: GateFinding[] = []
  for (const rule of RULES) {
    if (exclude.has(rule.id)) continue
    const message = rule.test(p, ctx)
    if (message) findings.push({ ruleId: rule.id, effect: rule.effect, message, learnedFrom: rule.learnedFrom })
  }
  return { passed: !findings.some((f) => f.effect === "block"), findings, checkedAt }
}

const PROMISE = /\b(we (will|'ll) (collect|pick|send|book|pay)|guarantee\w*|promise\w*|it is booked|is confirmed)\b/i

/** Text rules for what Ring says on a call or to a driver: no mechanical advice, no promises. */
export function checkSpeech(text: string): string | null {
  const m = MECHANICAL.exec(text)
  if (m) return `CL-01: no mechanical advice ("${m[0]}").`
  const p = PROMISE.exec(text)
  return p ? `No promises on Ring's behalf ("${p[0]}"). Ask, don't commit.` : null
}
