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
import { fmtDateTime, fmtRange, fmtWindow } from "@/lib/present/time"
import { ringEvents, ringProposals } from "@/lib/ring-schema"
import { byDeadline, dueSoon, inNow, nextAction, unanswered } from "./next-action"
import { activeClaim, needsYouSplit, type Claim } from "./claim"
import { readFileSync } from "node:fs"
import { buildQueue, buildStory } from "@/lib/agent/story"
import { currentFacts } from "./relevance"
import { personStep, thenLine } from "./follow-up"
import { orderFacts, rankFacts } from "./facts"
import { similarGroups } from "./similar"
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
    assert.equal(r.oneDecision, "Driver says they are safe and stopped (driver 11:22). Location unverified, no photo yet. Customer: keep it stopped (11:40). Decide with the customer: roadside or tow.")
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
    assert.equal(nextAction({ reason: "DUE_SOON", why: "Site, 11:10: “Who collects?”", oneDecision: null, sources: [] }), "Call site")
    assert.equal(nextAction({ reason: "DUE_SOON", why: "A trade-in receipt shares a branch.", oneDecision: null, sources: [] }), "Check release")
    assert.equal(nextAction({ reason: "DUE_SOON", why: "Something odd.", oneDecision: null, sources: [] }), null)
    assert.equal(nextAction({ reason: "WAITING_EXTERNAL", why: "", oneDecision: null, sources: [] }), null)
  })
  test("a synthetic scale copy triages like its original (only when scripts/scale-seed.ts has run)", () => {
    for (const id of bundles.keys()) {
      const of = /^(.*)-s\d$/.exec(id)?.[1]
      if (!of) continue
      const [a, b] = [t(of), t(id)]
      assert.deepEqual([b.bucket, b.reason, b.severity, b.decideBy, b.sources.length], [a.bucket, a.reason, a.severity, a.decideBy, a.sources.length], id)
    }
  })
  test("cached date formatters give the same text, and a bad zone still falls back to UTC", () => {
    const fresh = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    for (let i = 0; i < 2; i++) {
      assert.equal(fmtRange("2026-10-26T07:00:00Z", "2026-10-26T10:00:00Z", "Europe/Helsinki"), "26 Oct 09:00–12:00 EET")
      // one zone story: desk time first; a German slot adds its own clock, labelled (round 4)
      assert.equal(fmtWindow("2026-10-23T08:00:00Z", "2026-10-23T10:00:00Z", "Europe/Berlin"), "23 Oct 11:00–13:00 EEST (10:00–12:00 CEST, site time)")
      assert.equal(fmtWindow("2026-10-26T07:00:00Z", "2026-10-26T10:00:00Z", "Europe/Helsinki"), "26 Oct 09:00–12:00 EET")
      assert.equal(fmtWindow("2026-10-23T08:00:00Z", "2026-10-23T10:00:00Z", "Europe/Berlin", "site time", false), "23 Oct 11:00–13:00 (10:00–12:00 CEST, site time)")
      assert.equal(fmtDateTime("2026-10-21T08:24:00Z", "Not/AZone"), "21 Oct 08:24 UTC")
    }
    assert.equal(fmtDateTime("2026-10-21T08:24:00Z", "Europe/Helsinki", false), fresh.format(new Date("2026-10-21T08:24:00Z")).replace(",", ""))
  })
  test("every Needs-you row has a next-step chip; a row with no due time says so (judges, round 3)", () => {
    for (const id of bundles.keys()) {
      const r = t(id)
      if (r.bucket === "needs_you") assert.ok(nextAction(r), `${id} ${r.reason}: no chip for “${r.why}”`)
    }
    // The UI prints "No deadline" for a null decideBy; these are the rows that have none, on purpose.
    const none = [...bundles.keys()].filter((id) => t(id).bucket === "needs_you" && !t(id).decideBy).sort()
    assert.deepEqual(none, ["ord-00055", "ord-00201"])
  })
  test("a waiting driver's own words set the deadline; an alert's cutoff counts when no task does", () => {
    const r = t("ord-00593")
    assert.equal(r.decideBy, "2026-10-21T08:27:00.000Z") // "I can wait another 30 minutes" at 07:57
    assert.match(r.why, /11:27 \(said 10:57\)/)
    assert.equal(t("ord-00603").decideBy, "2026-10-21T12:00:00.000Z") // ferry check-in cutoff
    assert.equal(t("ord-00702").decideBy, "2026-10-21T11:00:00.000Z") // delivery promise ends
  })
  test("322: the customer's recorded roadside-or-tow choice turns the card into 'book it'", () => {
    const chose = { ...emptyRing(), events: [{ id: "revt-x", orderId: "ord-00322", at: "2026-10-21T09:10:00.000Z", command: "recovery.choice", actorType: "operator", actorId: "ops-readiness", proposalId: null, changes: { choice: "tow", note: "Customer on the phone 09:08" }, sourceRefs: [] }] }
    const r = t("ord-00322", chose)
    assert.equal(r.reason, "SAFETY")
    assert.match(r.oneDecision ?? "", /^Customer chose a tow \(recorded 12:10 by ops-readiness\)\. Book the tow \(it needs approval as a cost\)/)
    assert.equal(nextAction(r), "Book recovery")
  })
  test("the hero's Unanswered line: the newest driver message with no reply after it", () => {
    const entries = (id: string) => bundles.get(id)!.messages.map((m) => ({ actorKind: (m.authorType === "site_contact" ? "site" : m.authorType) as never, actor: m.authorType, at: m.authoredAt, text: m.body, ref: { table: "messages", id: m.id } }))
    assert.match(unanswered(entries("ord-00322"))?.text ?? "", /who is collecting the car/) // 08:58, nobody answered
    assert.match(unanswered(entries("ord-00593"))?.text ?? "", /wait another 30 minutes/)
    const answered = [...entries("ord-00322"), { actorKind: "operator" as never, actor: "op", at: "2026-10-21T09:01:00.000Z", text: "A tow is on its way.", ref: { table: "messages", id: "m-x" } }]
    assert.equal(unanswered(answered), null)
    const claimOnly = [...entries("ord-00322"), { actorKind: "operator" as never, actor: "op", at: "2026-10-21T09:01:00.000Z", text: "I'll handle it.", ref: { table: "ring_claims", id: "c-x" } }]
    assert.ok(unanswered(claimOnly)) // taking the order is not a reply to the driver
  })
  test("What we know: 322 leads with the warning, where the car stopped and the customer's call; its past pickup slot is history", () => {
    const b = bundles.get("ord-00322")!
    const facts = rankFacts(orderFacts(b, emptyRing(), NOW), t("ord-00322"), b.order.status)
    const first4 = facts.slice(0, 4).map((f) => f.subject)
    for (const s of ["incident.warning", "incident.location", "incident.recovery"]) assert.ok(first4.includes(s), `${s} not in the first 4: ${first4}`)
    assert.ok(facts.slice(0, 6).some((f) => f.subject === "alert.safety_stop"))
    assert.ok(!first4.some((s) => /contact$|^proof\./.test(s)), `contacts or photos lead: ${first4}`)
    const slot = facts.find((f) => f.subject === "pickup.slot")!
    assert.equal(slot.level, "stale"); assert.equal(slot.note, "Pickup done")
    // a record's "confirmed" status is not printed under a claimed fact
    assert.ok(!facts.some((f) => (f.level === "claimed" || f.level === "quoted") && /\bconfirmed\b/.test(f.note ?? "") && !/unconfirmed/.test(f.note ?? "")))
  })
  test("What we know on 593 leads with the site's word that the VIN is not there (with demo:seed's recorded run)", async (c) => {
    const s = await buildStory("ord-00593")
    if (!s?.facts.some((f) => f.sourceKind === "ring_call")) return c.skip("no recorded Ringo run on 593 in this database (run npm run demo:seed)")
    const first4 = currentFacts(s.facts).slice(0, 4)
    assert.ok(first4.some((f) => f.sourceKind === "ring_call" && /VIN/.test(f.claim) && /not/.test(f.claim)), first4.map((f) => f.claim).join(" | "))
    assert.ok(!first4.some((f) => /contact$/.test(f.subject)))
  })
  test("Now on the demo data: 322, 458, 593 are Now; 413 (due Monday) and 055 (medium) are not", () => {
    for (const id of ["ord-00322", "ord-00458", "ord-00593"]) assert.equal(inNow(t(id), NOW), true, id)
    for (const id of ["ord-00413", "ord-00055"]) assert.equal(inNow(t(id), NOW), false, id)
  })
})

describe("Now: safety, anything overdue or due within 30 min, or critical/high due within 2 h; sorted by deadline", () => {
  const at = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString()
  const row = (reason: string, severity: string, decideBy: string | null) => ({ reason, severity, decideBy }) as Parameters<typeof inNow>[0]
  test("the rule's edges", () => {
    assert.equal(inNow(row("SAFETY", "critical", null), NOW), true)       // safety always, even with no due time
    assert.equal(inNow(row("DUE_SOON", "high", at(-30)), NOW), true)      // overdue
    assert.equal(inNow(row("DUE_SOON", "high", at(120)), NOW), true)      // exactly 2 h
    assert.equal(inNow(row("DUE_SOON", "high", at(121)), NOW), false)     // just past the window
    assert.equal(inNow(row("DRIVER_WAITING", "high", null), NOW), false)  // no due time: when you can
    assert.equal(inNow(row("DUE_SOON", "medium", at(-600)), NOW), true)   // overdue is Now at any severity ("When you can" never says Overdue)
    assert.equal(inNow(row("DUE_SOON", "medium", at(60)), NOW), false)    // routine and not yet due
    assert.equal(inNow(row("DUE_SOON", "medium", at(30)), NOW), true)     // due within 30 min is Now at any severity
    assert.equal(inNow(row("DUE_SOON", "low", at(31)), NOW), false)       // just past the 30 min window
    assert.equal(dueSoon(row("DUE_SOON", "medium", at(10)), NOW), true)   // the quiet "due soon" marker
    assert.equal(dueSoon(row("DUE_SOON", "medium", at(-5)), NOW), false)  // overdue says "Overdue", not "due soon"
    assert.equal(dueSoon(row("DUE_SOON", "medium", at(31)), NOW), false)
  })
  test("Now is sorted by deadline: safety leads, then overdue (oldest first), then the soonest", () => {
    const rows = [row("DUE_SOON", "high", at(50)), row("DUE_SOON", "high", at(-43)), row("SAFETY", "critical", at(15)), row("DUE_SOON", "medium", at(10)), row("DUE_SOON", "high", at(-600))]
    assert.deepEqual(byDeadline(rows).map((r) => r.decideBy), [at(15), at(-600), at(-43), at(10), at(50)])
  })
  test("on the demo data every Now row is in deadline order, and no 'When you can' row is due within 30 min", async () => {
    const q = await buildQueue()
    const s = needsYouSplit(q.needsYou, q.now)
    const due = s.urgent.filter((x) => x.reason !== "SAFETY").map((x) => x.decideBy).filter((d): d is string => !!d)
    assert.deepEqual(due, [...due].sort())
    for (const x of s.later) assert.ok(!x.decideBy || Date.parse(x.decideBy) - Date.parse(q.now) > 30 * 60_000, `${x.orderId} is due within 30 min but sits in When you can`)
  })
})

describe("after a decision: the person's next step, its owner, and when the order comes back", () => {
  const names = { customer: "Pellavaro Auto", driver: "Yara Sivellin" }
  test("Ringo's 'what next' becomes the reader's own step", () => {
    assert.equal(personStep("A person contacts the customer to find the site that holds the VIN. The driver said…", names), "contact Pellavaro Auto to find the site that holds the VIN")
    assert.equal(personStep("After approval, a person can release driver dispatch.", names), "release driver dispatch")
    assert.equal(personStep("A person confirms the address with the customer first, then updates the pickup address.", names), "confirm the address with Pellavaro Auto first, then update the pickup address")
    assert.equal(personStep("The pickup access instruction is updated so any driver is sent to bay 4.", names), null) // an outcome, not a step
    assert.equal(thenLine("contact Pellavaro Auto to find the site that holds the VIN", "2026-10-21T09:40:00.000Z", names),
      "Then: you contact Pellavaro Auto to find the site that holds the VIN · owner: you (readiness desk) · back in your queue at 12:40 or when Pellavaro Auto replies")
  })
  test("an open follow-up keeps the order in Needs you, due at its recheck time; closing it lets it go", () => {
    const b = bundles.get("ord-00516")!
    const claim = { id: "claim-f", orderId: "ord-00516", by: "ops-readiness", note: "release driver dispatch", at: NOW, recheckAt: new Date(Date.parse(NOW) + 30 * 60_000).toISOString(), releasedAt: null }
    const ring = { ...emptyRing(), proposals: [{ status: "EXECUTED" } as never], claims: [claim] }
    const r = triage(b, ring, NOW)
    assert.equal(r.bucket, "needs_you"); assert.equal(r.decideBy, claim.recheckAt); assert.match(r.why, /^Your follow-up: release driver dispatch/)
    assert.equal(nextAction(r), "Your follow-up")
    const closed = triage(b, { ...ring, claims: [{ ...claim, releasedAt: NOW }] }, NOW)
    assert.ok(!closed.sources.some((s) => s.table === "ring_claims"))
  })
})

describe("I'll handle it: a claim holds until its recheck time, a hand-back, or something new", () => {
  const c: Claim = { id: "claim-x", orderId: "ord-1", by: "ops-readiness", note: null, at: "2026-10-21T09:14:00.000Z", recheckAt: "2026-10-21T09:44:00.000Z", releasedAt: null }
  test("the rule's edges", () => {
    assert.equal(activeClaim([c], "2026-10-21T08:58:00.000Z", "2026-10-21T09:20:00.000Z")?.id, "claim-x")
    assert.equal(activeClaim([c], "2026-10-21T08:58:00.000Z", "2026-10-21T09:44:00.000Z"), null) // recheck time reached: back to the queue
    assert.equal(activeClaim([c], "2026-10-21T09:30:00.000Z", "2026-10-21T09:31:00.000Z"), null) // a new event after the claim
    assert.equal(activeClaim([{ ...c, releasedAt: "2026-10-21T09:20:00.000Z" }], null, "2026-10-21T09:21:00.000Z"), null) // handed back
  })
})

describe("one count: Needs you means open rows nobody has taken, on every screen", () => {
  test("the split partitions Needs you; taken rows are never in the headline or the Decide pass", async () => {
    const q = await buildQueue()
    const rows: (typeof q.needsYou[number] & { claim?: Claim | null })[] = q.needsYou.map((x, i) => ({ ...x, claim: i === 1 ? { id: "c", orderId: x.orderId, by: "ops-readiness", note: null, at: q.now, recheckAt: q.now, releasedAt: null } : null }))
    const s = needsYouSplit(rows, q.now)
    assert.equal(s.open.length + s.taken.length, rows.length)
    assert.equal(s.taken.length, rows.length > 1 ? 1 : 0)
    assert.ok(s.open.every((x) => !x.claim))
    assert.deepEqual(s.open, [...s.urgent, ...s.later]) // Decide walks Now first, then the rest
  })
  test("queue header, shift report, Start deciding, Decide and the board toggle all count with needsYouSplit", () => {
    for (const f of ["app/page.tsx", "app/decide/page.tsx", "app/board/page.tsx"]) {
      const src = readFileSync(f, "utf8")
      assert.ok(src.includes("needsYouSplit"), `${f} counts Needs you without needsYouSplit`)
      assert.ok(!src.replace("queue.total - queue.needsYou.length", "").includes("needsYou.length"), `${f} shows needsYou.length (taken rows included) somewhere`)
    }
  })
})

describe("decide mode: similar proposals", () => {
  const prop = (id: string, actionType: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ id, origin: "ring", status: "PENDING_REVIEW", actionType, proposedPayload: payload, gate: { passed: true, findings: [], checkedAt: NOW }, ...extra }) as never
  test("same change on the same fields groups; locked, blocked, other fields and dataset proposals do not", () => {
    const groups = similarGroups([
      prop("a", "endpoint.record_access", { key_holder: "x", access_instruction: "y" }),
      prop("b", "endpoint.record_access", { access_instruction: "z", key_holder: "w" }),
      prop("c", "endpoint.record_access", { key_holder: "x" }),                                        // other fields
      prop("d", "address.update", { city: "Berlin" }), prop("e", "address.update", { city: "Hamburg" }), // locked: one at a time
      prop("f", "endpoint.record_access", { key_holder: "x", access_instruction: "y" }, { gate: { passed: false, findings: [{ ruleId: "CL-10", effect: "block" }] } }),
      prop("g", "endpoint.record_access", { key_holder: "x", access_instruction: "y" }, { origin: "dataset" }),
    ])
    assert.deepEqual(groups.map((g) => g.map((p: { id: string }) => p.id)), [["a", "b"]])
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
