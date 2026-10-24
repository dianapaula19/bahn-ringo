// Run Ringo once on an order from the terminal and print the stream in plain words.
//   npm run ring:run -- ord-00516 ["operator message"]
// Replay fixtures are written from stored runs by scripts/ring-record.ts.
import type { RunEvent } from "../lib/contract"
import { runRing } from "../lib/agent/loop"

export function describe(e: RunEvent): string {
  switch (e.type) {
    case "run_started": return `run ${e.runId} on ${e.orderId} (${e.trigger})`
    case "progress": return `  ring: ${e.text}`
    case "tool_call": return `  > ${e.tool} ${JSON.stringify(e.input).slice(0, 160)}`
    case "tool_result": return `  ${e.ok ? "ok" : "REFUSED"} ${e.summary}`
    case "call_turn": return `      [${e.turn.speaker}] ${e.turn.text}`
    case "call_ended": return `    call ended: ${e.call.outcome}`
    case "driver_message": return `      [driver ${e.message.direction}] ${e.message.body}`
    case "fact": return `    fact (${e.fact.level}) ${e.fact.claim} <- ${e.fact.sourceId}`
    case "gate": return `    gate ${e.result.passed ? "passed" : "BLOCKED"} ${e.result.findings.map((f) => f.ruleId).join(",")}`
    case "proposal": return `    proposal ${e.proposal.id} ${e.proposal.actionType} ${e.proposal.status} (${e.proposal.trustMode})`
    case "callback_scheduled": return `    callback at ${e.job.dueAt}`
    case "stop": return `STOP ${e.decision.outcome}: ${e.decision.headline}\n  decision: ${e.decision.oneDecision}\n  next: ${e.decision.whatNext}`
    case "error": return `ERROR ${e.message}`
    case "run_ended": return `run ended ${e.status}`
  }
}

async function main() {
  const [orderId, message] = process.argv.slice(2).filter((a) => !a.startsWith("--"))
  if (!orderId) throw new Error("usage: ring-run.ts <orderId> [message]")
  await runRing({ orderId, trigger: "operator", message, onEvent: (e) => console.log(describe(e)) })
  process.exit(0)
}

if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
