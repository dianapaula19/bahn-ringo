// Reviewer gate eval over the 14 dataset agent_proposals.
//   npm run eval:reviewer            leave-one-out (honest number)
//   npm run eval:reviewer -- --all   all rules (leaky upper bound)
// Leave-one-out: for each reviewed proposal, drop every rule whose learnedFrom
// contains ONLY that proposal, run the gate on the original proposed_payload,
// and compare with what the human did. Reads the dataset files directly.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { EvalCase, EvalReport, ReviewDecision } from "../lib/contract"
import { RULES, type GateContext } from "../lib/agent/caselaw"
import { runGate } from "../lib/agent/gate"

const DATA = process.env.DATASET_DIR ?? join(process.cwd(), "..", "dataset", "data")
const read = (name: string) => readFileSync(join(DATA, `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>)

/** What the reviewer objected to or conditioned on, as rule ids (CONTRACT §6). Empty = expect a clean pass. */
const EXPECTED: Record<string, string[]> = {
  "agent-x95169653143f1607": ["CL-01"], // 322 edited: remove restart advice
  "agent-x40ab609877909161": ["CL-02"], // 020 edited: keep boarding unconfirmed
  "agent-x3151927d69c76a10": ["CL-04"], // 194 edited: no pick from unrefreshed list
  "agent-xaa0af5ec9f775363": ["CL-03"], // 055 rejected: no blame from photos
  "agent-x4ac988b20000595f": ["CL-06"], // 299 failed: keep promise until booked
  "agent-x68cbbd7e6e58691c": ["CL-07"], // 154 approved: recheck only
  "agent-x44051005c0c18aaf": ["CL-08"], // 089 approved: still verify prior duty + arrival
  "agent-xf4800bb1b907cf89": ["CL-05"], // 449 approved: backup is not booked
  "agent-x1c721af5508e707a": ["CL-07"], // 603 approved: separate booking decision
  "agent-xf874ddfecf02bb68": ["CL-09"], // 194 approved: don't tell customer yet
}

function main() {
  const all = process.argv.includes("--all")
  const proposals = read("agent_proposals")
  const orders = new Map(read("orders").map((o) => [o.id, o.reference as string]))
  const ctx: GateContext = {
    travelOptionCheckedAt: Object.fromEntries(read("travel_options").map((t) => [t.id, t.checked_at])),
    verifiedIds: new Set([
      ...read("ferry_terminal_events").map((r) => r.id),
      ...read("proofs").filter((r) => r.status === "APPROVED").map((r) => r.id),
      ...read("documents").filter((r) => r.status === "VERIFIED").map((r) => r.id),
    ]),
  }
  const cases: EvalCase[] = []
  const opinions: string[] = []
  for (const p of proposals) {
    const input = { command: p.command, actionType: null, payload: p.proposed_payload, summary: p.summary, evidenceRefs: p.evidence_refs, createdAt: p.created_at }
    const exclude = all ? new Set<string>() : new Set(RULES.filter((r) => r.learnedFrom.length > 0 && r.learnedFrom.every((id) => id === p.id)).map((r) => r.id))
    const result = runGate(input, ctx, new Date().toISOString(), exclude)
    const fired = result.findings.map((f) => f.ruleId)
    const ref = orders.get(p.order_id) ?? p.order_id
    if (!p.review && p.status !== "FAILED") {
      opinions.push(`${ref} ${p.id} ${p.command}: ${result.passed ? "pass" : "BLOCK"}${fired.length ? ` (${result.findings.map((f) => `${f.ruleId} ${f.message}`).join("; ")})` : ""}`)
      continue
    }
    const expected = EXPECTED[p.id] ?? []
    const unexpectedBlock = result.findings.some((f) => f.effect === "block" && !expected.includes(f.ruleId))
    const humanDecision = (p.status === "FAILED" ? "FAILED" : p.review.decision) as ReviewDecision | "FAILED"
    cases.push({
      proposalId: p.id, orderRef: ref, humanDecision, humanNote: p.review?.decision_note ?? "",
      expected, fired, hit: expected.every((id) => fired.includes(id)) && !unexpectedBlock,
    })
  }
  const flaggedCases = cases.filter((c) => c.expected.length > 0)
  const report: EvalReport = {
    ranAt: new Date().toISOString(), mode: all ? "all_rules" : "leave_one_out", cases,
    flagged: flaggedCases.length,
    caught: flaggedCases.filter((c) => c.expected.every((id) => c.fired.includes(id))).length,
    falseAlarms: cases.filter((c) => c.humanDecision === "APPROVED" && c.expected.length === 0 && c.fired.length > 0).length,
    passed: cases.filter((c) => c.hit).length,
  }
  console.log(`Reviewer gate eval, ${report.mode.replace(/_/g, "-")} (${cases.length} reviewed proposals)\n`)
  for (const c of cases) console.log(`${c.hit ? "HIT " : "MISS"}  ${c.orderRef}  ${c.humanDecision.padEnd(8)} expected ${c.expected.join(",") || "-"}  fired ${c.fired.join(",") || "-"}\n      human: ${c.humanNote}`)
  console.log(`\ncaught ${report.caught}/${report.flagged} flagged, false alarms ${report.falseAlarms}, cases hit ${report.passed}/${cases.length}`)
  console.log(`\nGate opinions on pending proposals (unscored):\n${opinions.map((o) => `  ${o}`).join("\n")}`)
  mkdirSync("eval", { recursive: true })
  const file = join("eval", `gate-${report.mode}-${report.ranAt.replace(/[:.]/g, "-")}.json`)
  writeFileSync(file, JSON.stringify({ ...report, opinions }, null, 2))
  console.log(`\nwrote ${file}`)
}

main()
