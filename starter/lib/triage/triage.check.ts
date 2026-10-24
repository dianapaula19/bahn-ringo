// Self-checks for triage, the Reviewer gate and the evidence ladder (node:test).
//   npm run ring:check      (needs the seeded DB on :5438; Ringo rows are ignored)
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"
import type { Fact } from "@/lib/contract"
import { inArray, or } from "drizzle-orm"
import { db } from "@/lib/db"
import { RULES, type GateContext } from "@/lib/agent/caselaw"
import { SNAPSHOT, simNow } from "@/lib/agent/clock"
import { checkFact, type SourceInfo } from "@/lib/agent/facts"
import { checkSpeech, runGate } from "@/lib/agent/gate"
import { propose, review, type ProposeInput } from "@/lib/agent/proposals"
import { triageAll } from "@/lib/agent/story"
import { emptyRing, type RingOrderState } from "@/lib/agent/store"
import type { Bundle } from "@/lib/present/bundle"
import { loadOrder } from "@/lib/present/load"
import { ringEvents, ringProposals } from "@/lib/ring-schema"
import { nextAction } from "./next-action"
import { ringEligibility, triage } from "./triage"

const NOW = SNAPSHOT
// Close the DB pool so the process exits with node:test's own exit code.
after(() => db.$client.end())
let bundles = new Map<string, Bundle>()
const t = (orderId: string, ring: RingOrderState = emptyRing()) => triage(bundles.get(orderId)!, ring, NOW)

describe("triage on the demo orders (CONTRACT §8)", () => {
  before(async () => { bundles = new Map((await triageAll(NOW)).map((x) => [x.bundle.order.id, x.bundle])) })

  test("322 is the first SAFETY card, not a Ringo order, with a row-built decision", () => {
    const r = t("ord-00322")
    assert.equal(r.bucket, "needs_you"); assert.equal(r.reason, "SAFETY"); assert.equal(r.severity, "critical")
    assert.equal(r.oneDecision, "Driver says they are safe and stopped (driver 08:22). Location unverified, no photo yet. Customer: keep it stopped (08:40). Decide with the customer: roadside or tow.")
    assert.deepEqual(r.overtaken.map((o) => [o.ref.id, o.overtakenBy.id]), [["alert-x105238e92e7f3ba6", "alert-x539dcfdd5a51d9ab"]])
    assert.equal(ringEligibility(bundles.get("ord-00322")!).ok, false)
  })
  test("458 seller hold is AUTHORITY_BLOCKED", () => {
    const r = t("ord-00458")
    assert.equal(r.reason, "AUTHORITY_BLOCKED")
    assert.ok(r.sources.some((s) => s.id === "alert-xad90176c4d6e6fc5"))
  })
  test("593 driver on site is DRIVER_WAITING", () => assert.equal(t("ord-00593").reason, "DRIVER_WAITING"))
  test("516, 010, 023 are Ringo-workable by phone", () => {
    for (const id of ["ord-00516", "ord-00010", "ord-00023"]) {
      const r = t(id)
      assert.equal(r.bucket, "ring", id); assert.equal(r.reason, "RING_CAN_CALL", id)
      assert.ok(r.sources.length > 0, id)
    }
  })
  test("009 missing identity needs a person to contact the customer", () => assert.equal(t("ord-00009").reason, "CUSTOMER_CONTACT"))
  test("a driver row quotes the driver's own ask; an acknowledgement needs no answer", () => {
    const r = t("ord-00413")
    assert.equal(r.reason, "DRIVER_WAITING"); assert.match(r.why, /who confirms Tuesday's keys/)
    assert.notEqual(t("ord-00419").reason, "DRIVER_WAITING") // "Understood ... no cost to submit" on a cancelled collection
  })
  test("a high alert nobody has acknowledged needs a person", () => assert.equal(t("ord-00702").bucket, "needs_you"))
  test("every non-quiet result names its source rows", () => {
    for (const id of bundles.keys()) { const r = t(id); if (r.bucket !== "quiet") assert.ok(r.sources.length > 0, id) }
  })
  test("Ringo state moves cards: pending proposal, dropped call, callback", () => {
    const pending = { ...emptyRing(), proposals: [{ id: "prop-x", status: "PENDING_REVIEW", summary: "Record access", proposedPayload: {}, execution: null } as never] }
    assert.equal(t("ord-00516", pending).reason, "DECISION_WAITING")
    const call = { id: "call-x", status: "ended", outcome: "DROPPED_UNKNOWN" } as never
    assert.equal(t("ord-00010", { ...emptyRing(), calls: [call] }).reason, "FAILED_ACTION")
    const job = { id: "job-x", status: "scheduled", dueAt: "2026-10-21T10:00:00.000Z", reason: "retry" } as never
    assert.equal(t("ord-00010", { ...emptyRing(), calls: [call], jobs: [job] }).reason, "RING_WORKING")
  })
  test("queue rows name a concrete next step, or none", () => {
    const next = (id: string) => nextAction(t(id))
    assert.equal(next("ord-00322"), "Decide: roadside or tow")
    assert.equal(next("ord-00458"), "Confirm with customer")
    assert.equal(next("ord-00593"), "Answer driver")
    assert.equal(next("ord-00516"), "Run Ringo")
    assert.equal(nextAction({ reason: "DUE_SOON", why: "Site, 08:10 UTC: “Who collects?”", oneDecision: null, sources: [] }), "Call site")
    assert.equal(nextAction({ reason: "DUE_SOON", why: "A trade-in receipt shares a branch.", oneDecision: null, sources: [] }), null)
    assert.equal(nextAction({ reason: "WAITING_EXTERNAL", why: "", oneDecision: null, sources: [] }), null)
  })
})

describe("Reviewer gate", () => {
  const ctx: GateContext = { travelOptionCheckedAt: {}, verifiedIds: new Set(["terminal-1"]) }
  const gate = (payload: Record<string, unknown>, extra: Partial<Parameters<typeof runGate>[0]> = {}) =>
    runGate({ command: "driver.instruct", actionType: "driver.instruct", payload, summary: "", evidenceRefs: [], createdAt: NOW, ...extra }, ctx, NOW)
  const ids = (r: ReturnType<typeof gate>) => r.findings.map((f) => f.ruleId)

  test("CL-01 blocks restart advice and passes the human's edit", () => {
    assert.equal(gate({ authorize_restart: true, message: "Try restarting the vehicle once and send a location." }).passed, false)
    assert.equal(gate({ authorize_restart: false, message: "Please keep the vehicle stopped and send the service-area name. Nobody has cleared onward driving." }).passed, true)
  })
  test("CL-10 blocks contacting the customer", () => {
    const r = gate({ contact: ["site", "customer"] }, { command: "pickup.verify_identity", actionType: null })
    assert.equal(r.passed, false); assert.ok(ids(r).includes("CL-10"))
  })
  test("CL-02 needs a verified source for a confirmation flag", () => {
    assert.equal(gate({ mark_boarding_confirmed: true }, { command: "alert.resolve" }).passed, false)
    assert.equal(gate({ mark_boarding_confirmed: true }, { command: "alert.resolve", evidenceRefs: [{ table: "ferry_terminal_events", id: "terminal-1" }] }).passed, true)
  })
  test("CL-03 blocks blame; CL-05 conditions a backup", () => {
    assert.ok(ids(gate({ attribution: "DRIVER_CAUSED" }, { command: "condition.record_attribution" })).includes("CL-03"))
    const backup = gate({ cancel_current: false, look_for_backup: true }, { command: "assignment.prepare_backup" })
    assert.equal(backup.passed, true); assert.ok(ids(backup).includes("CL-05"))
  })
  test("every rule cites where it came from", () => {
    for (const r of RULES) assert.ok(r.id === "CL-10" || r.learnedFrom.every((id) => id.startsWith("agent-")) && r.learnedFrom.length > 0, r.id)
  })
  test("speech rules: no mechanical advice, no promises", () => {
    assert.ok(checkSpeech("Could you reset the warning light?"))
    assert.ok(checkSpeech("We will collect it tomorrow, guaranteed."))
    assert.equal(checkSpeech("Who holds the keys for order CD-420516?"), null)
  })
})

describe("evidence ladder", () => {
  const msg = (kind: string, at: string): SourceInfo => ({ table: "messages", orderId: "ord-1", at, kind, details: {} })
  const base = { subject: "pickup.key_holder", claim: "Reception has the keys.", sourceKind: "message" as const, sourceId: "msg-1", by: "Customer" }
  test("a customer message is at most claimed; verified is never allowed", () => {
    assert.ok("error" in checkFact("ord-1", { ...base, level: "quoted" }, msg("customer", "2026-10-19T10:44:00Z"), []))
    assert.ok("error" in checkFact("ord-1", { ...base, level: "verified" }, msg("site_contact", "2026-10-21T08:24:00Z"), []))
    assert.ok("fact" in checkFact("ord-1", { ...base, level: "claimed" }, msg("customer", "2026-10-19T10:44:00Z"), []))
  })
  test("unknown sources are rejected; a refutation must cite a later source", () => {
    assert.ok("error" in checkFact("ord-1", { ...base, level: "claimed" }, undefined, []))
    const old: Fact = { id: "fact-1", orderId: "ord-1", ...base, level: "claimed", at: "2026-10-19T10:44:00.000Z", origin: "ring", supersededByFactId: null, note: null }
    const refute = { ...base, claim: "Reception does not have the keys.", level: "quoted" as const, supersedesFactId: "fact-1", effect: "refutes" as const }
    const ok = checkFact("ord-1", refute, msg("site_contact", "2026-10-21T08:24:00Z"), [old])
    assert.ok("fact" in ok && ok.old?.level === "refuted")
    assert.ok("error" in checkFact("ord-1", refute, msg("site_contact", "2026-10-18T08:24:00Z"), [old]))
  })
})

// CL-00 recheck before write. Uses a quiet order and removes its own rows afterwards.
describe("recheck before write", () => {
  const ORDER = "ord-00004"
  const made: string[] = []
  after(async () => {
    if (!made.length) return
    await db.delete(ringEvents).where(or(inArray(ringEvents.proposalId, made), inArray(ringEvents.id, made)))
    await db.delete(ringProposals).where(inArray(ringProposals.id, made))
  })
  const input = (actionType: ProposeInput["actionType"]): ProposeInput => ({ command: actionType, actionType, targetType: "order", targetId: ORDER,
    payload: { note: "self-check" }, rationale: "self-check", summary: "self-check", evidenceRefs: [], onApprove: "Done.", onReject: "Nothing changes." })
  async function make(runId: string, actionType: ProposeInput["actionType"]) {
    const r = await propose((await loadOrder(ORDER))!.bundle, runId, input(actionType))
    assert.ok("proposal" in r, JSON.stringify(r)); made.push(r.proposal.id); return r.proposal.id
  }
  async function approve(id: string) {
    const { body } = await review(id, { decision: "APPROVED", note: null, reviewerId: "ops-readiness" })
    assert.ok("execution" in body, JSON.stringify(body)); return body.execution?.status
  }

  test("approving two sibling proposals from one run executes both (no false STALE)", async () => {
    const run = `run-check-${randomUUID()}`
    const first = await make(run, "pickup.hold"), second = await make(run, "slot.change")
    assert.equal(await approve(first), "SUCCEEDED")
    assert.equal(await approve(second), "SUCCEEDED")
  })
  test("any other newer event still makes the approval STALE", async () => {
    const id = await make(`run-check-${randomUUID()}`, "pickup.hold")
    const evt = `revt-check-${randomUUID()}`; made.push(evt)
    await db.insert(ringEvents).values({ id: evt, orderId: ORDER, at: new Date(Date.parse(await simNow()) + 60_000).toISOString(), command: "self_check.newer",
      actorType: "operator", actorId: "self-check", proposalId: null, changes: {}, sourceRefs: [] })
    assert.equal(await approve(id), "STALE")
  })
})
