// Eval for "Ringo learns from your edits" (lib/agent/learn). Deterministic, no model.
//   npm run eval:learned
// A. Pure checks on synthetic corrections: what becomes a suggestion, what a learned rule blocks
//    and what it lets through, plus a leave-one-out over a three-edit pattern.
// B. The real learned rules in this database, replayed: each must block the proposals people
//    corrected, pass what they wrote instead, and pass every proposal they accepted unchanged.
// C. The store round trip on throwaway rows: two rejections → one suggestion → dismiss → never again;
//    accept → in the gate → switch off → out of the gate. Rows are removed afterwards.
// Exits non-zero on any failed check.
import { inArray } from "drizzle-orm"
import { db } from "../lib/db"
import type { Proposal, Review } from "../lib/contract"
import { runGate } from "../lib/agent/gate"
import { derive, reasonClass, situationOf, violation, type CorrectionLite } from "../lib/agent/learn/derive"
import { decideLearned, learnedGateRules, listLearned, recordCorrections } from "../lib/agent/learn/store"
import { gateContext } from "../lib/agent/proposals"
import { toProposal } from "../lib/agent/store"
import { loadOrder } from "../lib/present/load"
import { ringCorrections, ringLearnedRules, ringProposals } from "../lib/ring-schema"

let failed = 0, passed = 0
const check = (name: string, ok: boolean, detail = "") => { ok ? passed++ : failed++; console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`) }

// ---------------------------------------------------------------- A. synthetic

const HOLD = ["COMMERCIAL_RELEASE_HOLD", "RELEASE_DOCUMENT_UNCLEAR"]
let n = 0
const edit = (actionType: CorrectionLite["actionType"], field: string, before: unknown, after: unknown, situation: string[] = []): CorrectionLite =>
  ({ id: `c${++n}`, proposalId: `prop-${n}`, actionType, kind: "edit", field, before, after, reasonClass: null, situation })
const reject = (actionType: CorrectionLite["actionType"], note: string, situation: string[] = []): CorrectionLite =>
  ({ id: `c${++n}`, proposalId: `prop-${n}`, actionType, kind: "reject", field: null, before: null, after: null, reasonClass: reasonClass(note), situation })

function partA() {
  console.log("A. synthetic corrections\n")
  const access = [
    edit("endpoint.record_access", "access_instruction", "Collect at the collection bay; stock control releases the keys.", "Collect at the collection bay; stock control releases the keys. Driver shows the order reference and driver ID at handover.", ["SITE_ACCESS_UNCONFIRMED"]),
    edit("endpoint.record_access", "access_instruction", "Report to the yard office at gate 2.", "Report to the yard office at gate 2. Driver shows the order reference and driver ID at handover.", ["PICKUP_ACCESS_CHECK_REQUIRED"]),
    edit("endpoint.record_access", "access_instruction", "Keys at the reception desk, ask for Ilona Alderbrook.", "Keys at the reception desk, ask for Ilona Alderbrook. Driver shows order reference and driver ID at handover."),
  ]
  check("one correction is not a pattern", derive(access.slice(0, 1)) === null)
  const two = derive(access.slice(0, 2))
  check("two edits adding the same sentence → a 'require' rule", two?.spec.require === "Driver shows the order reference and driver ID at handover", JSON.stringify(two?.spec))
  check("no shared open signal → the rule applies to every order", two?.spec.situation.length === 0)
  check("Ringo asks in the first person", !!two && /^Twice now you've added “Driver shows the order reference and driver ID at handover” to my access instruction\. Shall I always put it in\?$/.test(two.ask), two?.ask)
  const three = derive(access)
  check("a third, slightly different edit narrows the phrase", three?.spec.require === "order reference and driver ID at handover", three?.spec.require ?? "null")
  const spec = three!.spec
  const gate = (actionType: string, payload: Record<string, unknown>, situation: string[] = []) =>
    runGate({ command: actionType, actionType, payload, summary: "", evidenceRefs: [], createdAt: "2026-10-21T09:00:00Z" }, { travelOptionCheckedAt: {}, verifiedIds: new Set() }, "2026-10-21T09:00:00Z", undefined,
      [{ id: "CL-L01", effect: "block", learnedFrom: [], test: (p) => violation(spec, p, situation) }])
  check("blocks an access instruction without the handover check", !gate("endpoint.record_access", { access_instruction: "Use the side gate after 10:00." }).passed)
  check("passes one that has it (case and punctuation ignored)", gate("endpoint.record_access", { access_instruction: "Side gate after 10:00. ORDER REFERENCE and driver ID, at handover!" }).passed)
  check("leaves other action types alone", gate("endpoint.record_contact", { contact_name: "Mira Halvorsen" }).passed)
  check("case-law rules still run beside it", !gate("endpoint.record_access", { access_instruction: "Order reference and driver ID at handover. Restart the car if it warns." }).passed)

  // Leave-one-out: learn from two, test on the third's original and on what the person wrote.
  let caught = 0, falseAlarms = 0
  for (let i = 0; i < access.length; i++) {
    const rule = derive(access.filter((_, j) => j !== i))!
    const held = access[i]
    if (violation(rule.spec, { actionType: held.actionType, payload: { access_instruction: held.before } }, held.situation)) caught++
    if (violation(rule.spec, { actionType: held.actionType, payload: { access_instruction: held.after } }, held.situation)) falseAlarms++
  }
  console.log(`      leave-one-out over 3 edits: held-out original blocked ${caught}/3, held-out human version blocked ${falseAlarms}/3`)
  check("leave-one-out: every held-out original is blocked", caught === 3)

  const hold = [
    edit("pickup.hold", "reason", "Hold collection until the seller confirms release.", "Ask the customer first, then wait until the seller confirms release.", HOLD),
    edit("pickup.hold", "reason", "Hold collection while the release document is unclear.", "Ask the customer first while the release document is unclear.", [...HOLD, "KEY_HOLDER_STOCK_CHECK"]),
  ]
  const h = derive(hold)
  check("'changed X to Y' twice → require Y and forbid X", h?.spec.require === "Ask the customer first" && h?.spec.forbid === "Hold collection", JSON.stringify(h?.spec))
  check("scoped to what both orders had open (seller holds)", JSON.stringify(h?.spec.situation) === JSON.stringify(HOLD))
  check("the ask names the change and the cases", !!h && h.ask.startsWith("Twice now you've changed “Hold collection” to “Ask the customer first” in my pickup hold on orders flagged “commercial release hold”"), h?.ask)
  check("blocks 'hold collection' on a seller hold", !!violation(h!.spec, { actionType: "pickup.hold", payload: { reason: "Hold collection until payment clears." } }, HOLD))
  check("does not block it on an order without a seller hold", violation(h!.spec, { actionType: "pickup.hold", payload: { reason: "Hold collection until payment clears." } }, ["KEY_HOLDER_STOCK_CHECK"]) === null)

  const rej = [reject("driver.instruct", "The customer has to agree before the driver leaves.", ["EMPTY_PICKUP"]), reject("driver.instruct", "Ask the customer first, not the driver.", ["EMPTY_PICKUP", "SITE_ACCESS_UNCONFIRMED"])]
  const r = derive(rej)
  check("two rejections for the same reason → stop proposing it there", r?.spec.field === null && JSON.stringify(r?.spec.situation) === JSON.stringify(["EMPTY_PICKUP"]), JSON.stringify(r?.spec))
  check("…and it blocks only that action, only there", !!violation(r!.spec, { actionType: "driver.instruct", payload: { message: "You can leave." } }, ["EMPTY_PICKUP"])
    && violation(r!.spec, { actionType: "driver.instruct", payload: { message: "You can leave." } }, []) === null)
  check("rejections for different reasons are not a pattern", derive([reject("pickup.hold", "Customer decides."), reject("pickup.hold", "Too early, not yet.")]) === null)
  check("'other' reasons are never learned from", derive([reject("pickup.hold", "Meh."), reject("pickup.hold", "Nope.")]) === null)
  check("two edits with nothing in common → no suggestion", derive([edit("driver.instruct", "message", "Wait at the gate.", "Wait at the side gate."), edit("driver.instruct", "message", "Call the desk.", "Text the desk at 10.")]) === null)
  const flag = derive([edit("endpoint.record_contact", "share_with_driver", false, true), edit("endpoint.record_contact", "share_with_driver", false, true)])
  check("a yes/no flipped the same way twice → an 'equals' rule", flag?.spec.equals === true)
  const safe = derive([edit("driver.instruct", "message", "Wait there.", "Wait there. Stay away from the road.", ["VEHICLE_WARNING"]), edit("driver.instruct", "message", "Stay put.", "Stay put. Stay away from the road.", ["VEHICLE_WARNING"])])
  check("in a safety case Ringo drops the patter", !!safe && safe.ask.startsWith("You've added") && !safe.ask.includes("Twice"), safe?.ask)
}

// ---------------------------------------------------------------- B. the real rules in this database

async function partB() {
  console.log("\nB. learned rules in this database, replayed\n")
  const rules = (await listLearned()).filter((r) => r.status !== "dismissed")
  if (!rules.length) { console.log("      no learned rules or suggestions yet (review some of Ringo's proposals first)"); return }
  const props = (await db.select().from(ringProposals)).map(toProposal)
  const situations = new Map<string, string[]>()
  const situationFor = async (orderId: string) => {
    if (!situations.has(orderId)) situations.set(orderId, situationOf((await loadOrder(orderId))!.bundle))
    return situations.get(orderId)!
  }
  for (const rule of rules) {
    console.log(`      ${rule.ruleId ?? "suggested"} (${rule.status}) ${rule.text}`)
    for (const c of rule.citations) {
      const sit = await situationFor(c.orderId)
      const original = props.find((p) => p.id === c.proposalId)
      if (c.decision === "EDITED") {
        check(`${c.orderRef}: blocks what Ringo wrote`, !!violation(rule.spec, { actionType: rule.actionType, payload: { [c.field!]: c.before } }, sit))
        check(`${c.orderRef}: passes what the person wrote`, violation(rule.spec, { actionType: rule.actionType, payload: { [c.field!]: c.after } }, sit) === null)
      } else check(`${c.orderRef}: blocks the rejected proposal`, !original || !!violation(rule.spec, { actionType: original.actionType, payload: original.proposedPayload }, sit))
    }
    for (const p of props.filter((p) => p.review?.decision === "APPROVED" && p.review.finalPayload))
      check(`${p.id} (${p.actionType}, accepted unchanged): not blocked`, violation(rule.spec, { actionType: p.actionType, payload: p.review!.finalPayload }, await situationFor(p.orderId)) === null)
  }
}

// ---------------------------------------------------------------- C. store round trip

async function partC() {
  console.log("\nC. store round trip on throwaway rows\n")
  const loaded = (await loadOrder("ord-00458"))!
  const now = "2026-10-21T09:30:00.000Z"
  const fake = (i: number): Proposal => ({ ...toProposal({
    id: `prop-evaltmp-${i}`, orderId: "ord-00458", runId: null, command: "pickup.hold", actionType: "pickup.hold", targetType: "order", targetId: "ord-00458", alertId: null,
    proposedPayload: { reason: "Hold collection until the invoice is paid." }, rationale: "", summary: "", evidenceRefs: [], dependency: {}, status: "PENDING_REVIEW",
    review: null, execution: null, supersededByProposalId: null, onApprove: null, onReject: null, gate: null, trustMode: "ask", createdAt: now,
  }) })
  const rv = (i: number, decision: Review["decision"], note: string, finalPayload: Record<string, unknown>): Review => ({ decision, decisionNote: note, finalPayload, reviewerId: "ops-readiness", reviewedAt: `2026-10-21T09:3${i}:00.000Z` })
  const ids: string[] = []
  const created = async () => (await db.select().from(ringCorrections).where(inArray(ringCorrections.proposalId, [1, 2, 3, 4, 5].map((i) => `prop-evaltmp-${i}`)))).map((c) => c.patternKey)
  try {
    const keep = "Hold nothing yet."
    check("first rejection: no question", (await recordCorrections(fake(1), rv(1, "REJECTED", "The customer must decide first.", fake(1).proposedPayload), loaded.bundle)) === null)
    const s = await recordCorrections(fake(2), rv(2, "REJECTED", "Ask the customer before any hold.", fake(2).proposedPayload), loaded.bundle)
    check("second rejection for the same reason: Ringo suggests a rule", s?.status === "suggested" && s.citations.length === 2, JSON.stringify(s?.status))
    if (s) ids.push(s.id)
    check("the suggestion cites both reviews", JSON.stringify(s?.learnedFrom) === JSON.stringify(["prop-evaltmp-1", "prop-evaltmp-2"]))
    check("a suggestion is not in the gate", !(await learnedGateRules(loaded.bundle)).some((r) => r.learnedFrom.includes("prop-evaltmp-1")))
    const acc = await decideLearned(s!.id, { action: "accept", operatorId: "ops-readiness" })
    const rule = "rule" in acc.body ? acc.body.rule : null
    check("accept → a CL-L rule, version 1", !!rule?.ruleId?.startsWith("CL-L") && rule.version === 1 && rule.status === "active")
    const inGate = (await learnedGateRules(loaded.bundle)).find((r) => r.id === rule?.ruleId)
    check("…and the gate blocks the next pickup hold on this order", !!inGate && !runGate({ command: "pickup.hold", actionType: "pickup.hold", payload: { reason: keep }, summary: "", evidenceRefs: [], createdAt: now }, gateContext(loaded.bundle), now, undefined, [inGate]).passed)
    const ed = await decideLearned(s!.id, { action: "edit", text: "No pickup holds on a seller hold; the customer decides.", operatorId: "ops-shift" })
    check("edit wording → version 2, history kept", "rule" in ed.body && ed.body.rule.version === 2 && ed.body.rule.history.length === 2)
    await decideLearned(s!.id, { action: "off", operatorId: "ops-shift" })
    check("switched off → out of the gate", !(await learnedGateRules(loaded.bundle)).some((r) => r.id === rule?.ruleId))
    await decideLearned(s!.id, { action: "on", operatorId: "ops-shift" })
    check("switched on again → back in", (await learnedGateRules(loaded.bundle)).some((r) => r.id === rule?.ruleId))
    // A dismissed pattern stays quiet, however many more corrections arrive.
    const e1 = await recordCorrections(fake(3), rv(3, "EDITED", "Customer first.", { reason: "Ask the customer first; no hold yet." }), loaded.bundle)
    const e2 = await recordCorrections(fake(4), rv(4, "EDITED", "Customer first.", { reason: "Ask the customer first about the invoice." }), loaded.bundle)
    check("two matching edits → a suggestion", e1 === null && e2?.status === "suggested", JSON.stringify(e2?.spec))
    if (e2) { ids.push(e2.id); await decideLearned(e2.id, { action: "dismiss", operatorId: "ops-readiness" }) }
    const e3 = await recordCorrections(fake(5), rv(5, "EDITED", "Customer first.", { reason: "Ask the customer first, please." }), loaded.bundle)
    check("dismissed → never asked again for that pattern", e3 === null && (await created()).length === 5)
  } finally {
    await db.delete(ringCorrections).where(inArray(ringCorrections.proposalId, [1, 2, 3, 4, 5].map((i) => `prop-evaltmp-${i}`)))
    if (ids.length) await db.delete(ringLearnedRules).where(inArray(ringLearnedRules.id, ids))
  }
}

async function main() {
  partA()
  await partB()
  await partC()
  console.log(`\n${passed} passed, ${failed} failed`)
  await db.$client.end()
  process.exit(failed ? 1 : 0)
}

main().catch(async (e) => { console.error(e); await db.$client.end(); process.exit(1) })
