// Ringo behaviour eval (needs the model key): runs Ringo on the demo orders and
// asserts the behaviour column of CONTRACT §8. Clears Ringo's rows for those
// orders first. Prints pass/fail per assertion.
//   npm run eval:ring [-- ord-00516 ...]
import type { RunEvent } from "../lib/contract"
import { clearOrder, runDue } from "../lib/agent/jobs"
import { runRing } from "../lib/agent/loop"
import { ringFor } from "../lib/agent/store"

type Check = [string, boolean]
const ORDERS = ["ord-00516", "ord-00458", "ord-00593", "ord-00010", "ord-00023"]

async function evalOrder(orderId: string): Promise<Check[]> {
  await clearOrder(orderId)
  const events: RunEvent[] = []
  const run = await runRing({ orderId, trigger: "eval", onEvent: (e) => { events.push(e) } })
  if (orderId === "ord-00010") await runDue({ wait: true, force: true })
  const ring = await ringFor(orderId)
  const outcome = [...ring.runs].reverse().find((r) => r.decision)?.decision?.outcome
  const types = ring.proposals.map((p) => p.actionType)
  const noCustomer = !types.includes("customer.message") && !ring.proposals.some((p) => JSON.stringify(p.proposedPayload).includes("customer\""))
  const readFirst = (() => { const t = events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool); const call = t.indexOf("place_call"); return call === -1 || (t.slice(0, call).includes("read_order") && t.slice(0, call).includes("read_messages")) })()
  const base: Check[] = [["run finished", run.status === "stopped"], ["read before dialling", readFirst], ["no customer contact", noCustomer], ["never verified", !ring.facts.some((f) => f.level === "verified")]]
  switch (orderId) {
    case "ord-00516": return [...base,
      ["refutes reception-has-keys from msg-x5d8006558b9e7cc6", ring.facts.some((f) => f.sourceId === "msg-x5d8006558b9e7cc6") && ring.facts.some((f) => f.level === "refuted")],
      ["does not re-ask reception", !ring.calls.some((c) => c.ivrPath.includes("reception"))],
      ["records a quoted fact from the call", ring.facts.some((f) => f.sourceKind === "ring_call" && f.level === "quoted")],
      ["proposes endpoint.record_access", types.includes("endpoint.record_access")], ["stops proposal_ready", outcome === "proposal_ready"]]
    case "ord-00458": return [...base, ["does not call", ring.calls.length === 0], ["stops needs_person", outcome === "needs_person"], ["proposes nothing", ring.proposals.length === 0]]
    case "ord-00593": return [...base, ["asks the driver", ring.driverMessages.some((d) => d.direction === "out" && d.intent === "question")],
      ["driver instruction goes to a person", ring.proposals.filter((p) => p.actionType === "driver.instruct").every((p) => p.status === "PENDING_REVIEW")],
      ["stops needs_person or proposal_ready", outcome === "needs_person" || outcome === "proposal_ready"]]
    case "ord-00010": return [...base, ["first call DROPPED_UNKNOWN", ring.calls[0]?.outcome === "DROPPED_UNKNOWN"],
      ["schedules a callback", ring.jobs.length > 0], ["second call carries reconciled", ring.calls.length > 1 && ring.calls[1].reconciledFrom?.callId === ring.calls[0].id],
      ["proposes endpoint.record_contact", types.includes("endpoint.record_contact")]]
    case "ord-00023": return [...base, ["does not change the address", ring.events.length === 0], ["proposes address.update (locked ask)", ring.proposals.some((p) => p.actionType === "address.update" && p.trustMode === "ask")],
      ["stops proposal_ready", outcome === "proposal_ready"]]
  }
  return base
}

async function main() {
  const orders = process.argv.slice(2).filter((a) => a.startsWith("ord-"))
  const results = await Promise.all((orders.length ? orders : ORDERS).map(async (id) => [id, await evalOrder(id)] as const))
  let pass = 0, total = 0
  for (const [id, checks] of results) for (const [name, ok] of checks) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}`) }
  console.log(`\n${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
