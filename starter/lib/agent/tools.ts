// Ringo's 10 tools: schemas for the model and executors with code-enforced
// guards (CONTRACT §5). The model decides what to read, whom to call, what to
// ask; these functions decide what is allowed and what it means.
import { and, eq, isNull } from "drizzle-orm"
import type Anthropic from "@anthropic-ai/sdk"
import { db } from "@/lib/db"
import type { ActionType, CallRecord, Fact, RunEvent, SourceKind, SourceRef, StopDecision, ToolName } from "@/lib/contract"
import { readAttachmentManifest } from "@/lib/attachments"
import { rows, type Bundle } from "@/lib/present/bundle"
import type { OrderLoad } from "@/lib/present/load"
import { ringDriverMessages, ringFacts, ringJobs, ringMeta } from "@/lib/ring-schema"
import { orderFacts } from "@/lib/triage/facts"
import { pickupSiteId, triage } from "@/lib/triage/triage"
import { newId, simNow } from "./clock"
import { type AiTraceContext } from "./llm"
import { checkFact, resolveSources, type FactInput } from "./facts"
import { checkSpeech } from "./gate"
import { datasetProposals, propose } from "./proposals"
import { driverReply } from "./sim/driver"
import { callStep, isOpen, loadCall, MAX_INPUTS, startCall } from "./sim/phone"
import { scenarioFor } from "./sim/scenarios"
import { ringFor, toDriverMessage, type RingOrderState } from "./store"

export const LIMITS = { toolCalls: 24, callInputs: MAX_INPUTS, proposeAttempts: 3 }

export type RunCtx = {
  runId: string
  orderId: string
  loaded: OrderLoad
  emit: (e: RunEvent) => Promise<void>
  reads: { order: string | null; messages: string | null; docs: string | null }
  liveCallId: string | null
  proposeAttempts: number
  toolCalls: number
  did: string[]
  stopped: StopDecision | null
  ai: AiTraceContext | null
}

export type ToolOutcome = { ok: boolean; summary: string; content: unknown }

const S = (properties: Record<string, unknown>, required: string[]) => ({ type: "object" as const, properties, required, additionalProperties: false })
const str = { type: "string" }
const ref = S({ table: str, id: str }, ["table", "id"])
const LEVELS = ["claimed", "quoted", "reserved", "observed"]
const KINDS: SourceKind[] = ["message", "order_note", "endpoint_detail", "endpoint_claim", "site_profile", "alert", "incident", "work_item",
  "time_window", "work_assignment", "travel_option", "travel_reservation", "tracking", "ferry_gate", "proof", "document", "event",
  "agent_proposal", "ring_call", "ring_driver_message", "ring_event"]
const ACTIONS: ActionType[] = ["driver.instruct", "endpoint.record_contact", "endpoint.record_access", "pickup.hold", "address.update",
  "slot.change", "booking.change", "cost.approve", "customer.message", "diagnosis", "attribution", "booking.cancel"]

const LOOSE: string[] = ["record_fact", "propose_action", "stop_with_decision"]

export const TOOLS: Anthropic.Tool[] = ([
  ["read_order", "Read the order: status, route, pickup and delivery details, selected slot, driver, open alerts, incidents, work items, recorded proposals, existing facts and the triage result. Every item has an id you can cite. Always call this first.", S({ orderId: str }, ["orderId"])],
  ["read_messages", "Read the order's messages (customer, site, driver, operator), plus Ringo's earlier calls with transcripts and driver chats. Call before dialling and again after any call that ended without an answer.", S({ orderId: str, sinceIso: str }, ["orderId"])],
  ["read_docs", "Read documents, proofs, attachment list and the pickup site's profile rules (release rule, signed release, hours, notice, access notes).", S({ orderId: str }, ["orderId"])],
  ["record_fact", "Record one fact on the evidence ladder. Cite a real source id. The level is capped by the source type: a customer or driver message is at most claimed, a site call or site message at most quoted. Never verified. To overturn an earlier fact, record what the new source says and pass supersedesFactId with effect 'refutes' (contradicted) or 'replaces' (newer information).",
    S({ subject: { type: "string", description: "Stable key, e.g. pickup.key_holder, pickup.access_route, pickup.contact, pickup.address, car.location" },
      claim: { type: "string", description: "One plain sentence, no hedging." }, level: { type: "string", enum: LEVELS }, sourceKind: { type: "string", enum: KINDS },
      sourceId: str, by: { type: "string", description: "Who said it, e.g. 'Velantora Helsinki stock control (simulated call)', 'Customer'." },
      supersedesFactId: str, effect: { type: "string", enum: ["refutes", "replaces"] }, note: str }, ["subject", "claim", "level", "sourceKind", "sourceId", "by"])],
  ["place_call", "Dial the order's pickup site or pickup contact (simulated phone line with a menu). Only after read_order and read_messages. Never a customer or a delivery contact. If the last call dropped or went unanswered, pass `reconciled` with that call id and what you re-read and found.",
    S({ orderId: str, siteId: str, purpose: str, reconciled: S({ callId: str, finding: str }, ["callId", "finding"]) }, ["orderId", "siteId", "purpose"])],
  ["call_input", "Act on the live call: exactly one of press (menu digit), say (speak to a person or voicemail), wait (stay on hold or let a menu repeat), hangup.",
    S({ callId: str, press: str, say: str, wait: { type: "boolean" }, hangup: { type: "boolean" } }, ["callId"])],
  ["send_driver_message", "Message the order's assigned driver (simulated). A question is sent and answered. An instruction (anything that changes what the driver does) is not sent: it becomes a driver.instruct proposal for a person.",
    S({ orderId: str, body: str, intent: { type: "string", enum: ["question", "instruction"] } }, ["orderId", "body", "intent"])],
  ["propose_action", "Propose a change for a person to review. The Reviewer gate checks it first and the trust ledger decides whether it needs approval. Payload is a list of key/value entries. Use these keys: endpoint.record_access → access_instruction (the full new instruction, one sentence); endpoint.record_contact → contact_name, contact_role, contact_handle; address.update → address_line1, city; driver.instruct → message; pickup.hold → reason.",
    S({ command: { type: "string", description: "Dotted, e.g. endpoint.record_access" }, actionType: { type: "string", enum: ACTIONS }, targetType: str, targetId: str, alertId: str,
      payload: { type: "array", items: S({ key: str, value: { anyOf: [{ type: "string" }, { type: "boolean" }, { type: "array", items: { type: "string" } }] } }, ["key", "value"]) },
      rationale: str, summary: str, evidenceRefs: { type: "array", items: ref },
      onApprove: { type: "string", description: "What happens after approval, one sentence the reviewer reads before clicking." }, onReject: str },
      ["command", "actionType", "targetType", "targetId", "payload", "rationale", "summary", "evidenceRefs", "onApprove", "onReject"])],
  ["schedule_callback", "Schedule Ringo to try again later (within the site's opening hours), e.g. after a dropped or unanswered call.", S({ orderId: str, dueAt: { type: "string", description: "UTC ISO time" }, reason: str }, ["orderId", "dueAt", "reason"])],
  ["stop_with_decision", "End the run with one clear outcome for a person. Use outcome proposal_ready only when a proposal is pending.",
    S({ outcome: { type: "string", enum: ["proposal_ready", "needs_person", "waiting", "done", "failed"] }, headline: { type: "string", description: "At most 120 characters." },
      oneDecision: { type: ["string", "null"] }, options: { type: "array", items: S({ label: str, proposalId: { type: ["string", "null"] } }, ["label", "proposalId"]) },
      found: { type: "array", items: str, description: "Fact ids supporting the headline." }, did: { type: "array", items: str, description: "Short past-tense lines." },
      whatNext: str, nextCheckAt: { type: ["string", "null"] }, ownerDesk: { type: ["string", "null"] } },
      ["outcome", "headline", "oneDecision", "options", "found", "did", "whatNext", "nextCheckAt", "ownerDesk"])],
] as const).map(([name, description, input_schema]) => ({
  // ponytail: the three big schemas are not strict (the grammar would be too large); runTool checks required fields instead.
  name, description, input_schema, ...(LOOSE.includes(name) ? {} : { strict: true }),
} as unknown as Anthropic.Tool))

const hhmm = (iso: string | null | undefined) => (iso ? `${iso.slice(11, 16)} UTC` : "?")
const b = (ctx: RunCtx): Bundle => ctx.loaded.bundle
const site = (ctx: RunCtx, id: string | null) => (id ? b(ctx).sites.get(id) ?? null : null)

async function facts(ctx: RunCtx, ring?: RingOrderState): Promise<Fact[]> {
  return orderFacts(b(ctx), ring ?? (await ringFor(ctx.orderId)), await simNow())
}

// ------------------------------------------------------------------ readers

async function readOrder(ctx: RunCtx): Promise<ToolOutcome> {
  const now = await simNow()
  const bundle = b(ctx), ring = await ringFor(ctx.orderId)
  const f = await facts(ctx, ring)
  const pickupId = pickupSiteId(bundle)
  const ps = site(ctx, pickupId)
  const asg = rows(bundle, "work_assignments").find((a) => a.details.status !== "CANCELLED")
  const content = {
    now,
    order: { id: bundle.order.id, reference: bundle.order.reference, status: bundle.order.status, readiness: bundle.order.details.readiness_status, customerId: bundle.customer.id, customer: bundle.customer.name },
    vehicle: bundle.items.map((i) => ({ role: i.role, car: `${i.vehicle.make} ${i.vehicle.model} ${i.vehicle.year ?? ""}`.trim(), vin: i.vehicle.vin, plate: i.vehicle.registration })),
    pickup: { address: ctx.loaded.pickup && { id: ctx.loaded.pickup.id, name: ctx.loaded.pickup.name, city: ctx.loaded.pickup.city, line1: ctx.loaded.pickup.details.address_line1 ?? null, rawInput: ctx.loaded.pickup.details.raw_input ?? null },
      site: ps && { id: ps.id, name: ps.name, city: ps.city, timezone: ps.details.timezone, openingHours: ps.details.opening_hours, customerId: ps.details.customer_id } },
    delivery: { city: ctx.loaded.delivery?.city ?? null, note: "Delivery contacts and the customer are never called by Ringo." },
    callableSites: ps ? [{ siteId: ps.id, name: ps.name, number: `sim:${ps.id}`, basis: bundle.order.pickupSiteId ? "pickup site" : "pickup contact handle" }] : [],
    endpointDetails: rows(bundle, "order_endpoint_details").map((e) => ({ id: e.id, ...e.details })),
    timeWindows: rows(bundle, "time_windows").map((w) => ({ id: w.id, purpose: w.details.purpose, selected: w.details.is_selected, start: w.details.start_at, end: w.details.end_at, timezone: w.details.timezone, source: w.details.source })),
    assignment: asg ? { id: asg.id, status: asg.details.status, driverId: asg.details.driver_id, driver: bundle.dir.driverName(asg.details.driver_id) } : null,
    alerts: bundle.alerts.filter((a) => a.status !== "RESOLVED").map((a) => ({ id: a.id, signal: a.signal, severity: a.severity, status: a.status, summary: a.summary, at: a.triggeredAt, owner: a.details.owner ?? null })),
    incidents: rows(bundle, "incidents").map((i) => ({ id: i.id, ...i.details })),
    workItems: rows(bundle, "work_items").map((w) => ({ id: w.id, kind: w.details.kind, status: w.details.status, due: w.details.due_at, owner: w.details.owner, nextAction: w.details.next_action, summary: w.details.summary })),
    orderNotes: rows(bundle, "order_notes").map((n) => ({ id: n.id, at: n.details.authored_at, author: n.details.author_type, body: n.details.body })),
    recordedProposals: datasetProposals(bundle, now).map((p) => ({ id: p.id, command: p.command, status: p.status, summary: p.summary, payload: p.proposedPayload, gate: p.gate?.findings.map((x) => `${x.ruleId} ${x.effect}: ${x.message}`) })),
    ringProposals: ring.proposals.map((p) => ({ id: p.id, actionType: p.actionType, status: p.status, summary: p.summary, execution: p.execution?.status ?? null })),
    facts: f.map((x) => ({ id: x.id, subject: x.subject, claim: x.claim, level: x.level, source: `${x.sourceKind}:${x.sourceId}`, at: x.at, by: x.by, supersededBy: x.supersededByFactId })),
    callbacks: ring.jobs.filter((j) => j.status === "scheduled").map((j) => ({ id: j.id, dueAt: j.dueAt, reason: j.reason })),
    triage: (({ reason, why, bucket }) => ({ reason, why, bucket }))(triage(bundle, ring, now, f)),
  }
  ctx.reads.order = now
  const open = content.alerts.length + content.workItems.filter((w) => w.status === "OPEN").length
  return { ok: true, content, summary: `Read the order: ${bundle.order.status.toLowerCase().replace(/_/g, " ")}, ${open} open item${open === 1 ? "" : "s"}, ${f.length} facts` }
}

async function readMessages(ctx: RunCtx, input: { sinceIso?: string }): Promise<ToolOutcome> {
  const now = await simNow()
  const ring = await ringFor(ctx.orderId)
  const since = input.sinceIso ? Date.parse(input.sinceIso) : 0
  const dir = b(ctx).dir
  const msgs = ctx.loaded.messages.filter((m) => m.authoredAt.getTime() >= since).map((m) => ({
    id: m.id, at: m.authoredAt.toISOString(), channel: m.details.channel, author: dir.resolve(m.details.author_id, m.authorType).name, authorType: m.authorType,
    recipient: m.details.recipient_type, language: m.details.language, visibility: m.details.visibility, body: m.body,
  }))
  const calls = ring.calls.map((c) => ({ id: c.id, siteId: c.siteId, startedAt: c.startedAt, endedAt: c.endedAt, outcome: c.outcome, path: c.ivrPath, reconciledFrom: c.reconciledFrom,
    transcript: c.transcript.map((t) => `${t.speaker}${t.dtmf ? ` [${t.dtmf}]` : ""}: ${t.text}`) }))
  const chats = ring.driverMessages.map((d) => ({ id: d.id, at: d.at, direction: d.direction, intent: d.intent, body: d.body }))
  ctx.reads.messages = now
  const last = msgs[msgs.length - 1]
  return {
    ok: true, content: { now, messages: msgs, ringCalls: calls, ringDriverMessages: chats },
    summary: `Read ${msgs.length} message${msgs.length === 1 ? "" : "s"}${last ? ` (latest: ${String(last.channel).replace(/_/g, " ")} ${hhmm(last.at)})` : ""}${calls.length ? `, ${calls.length} earlier Ringo call${calls.length === 1 ? "" : "s"}` : ""}`,
  }
}

async function readDocs(ctx: RunCtx): Promise<ToolOutcome> {
  const bundle = b(ctx)
  const ps = site(ctx, pickupSiteId(bundle))
  const attachments = (await readAttachmentManifest().catch(() => [])).filter((a) => a.order_id === ctx.orderId)
  const content = {
    documents: rows(bundle, "documents").map((d) => ({ id: d.id, ...d.details })),
    proofs: rows(bundle, "proofs").map((p) => ({ id: p.id, ...p.details })),
    attachments: attachments.map((a) => ({ id: a.id, kind: a.kind, file: a.file_name, for: `${a.related_record_type}:${a.related_record_id}`, status: a.status })),
    pickupSiteProfile: ps && { id: ps.id, name: ps.name, releaseDocumentRule: ps.details.release_document_rule, requiresSignedRelease: ps.details.requires_signed_release,
      openingHours: ps.details.opening_hours, timezone: ps.details.timezone, advanceNoticeMinutes: ps.details.advance_notice_minutes, pickupAccessNote: ps.details.pickup_access_note, handoverMode: ps.details.handover_mode },
  }
  ctx.reads.docs = await simNow()
  return { ok: true, content, summary: `Read ${content.documents.length} document${content.documents.length === 1 ? "" : "s"}, ${content.proofs.length} proof${content.proofs.length === 1 ? "" : "s"}${ps ? ` and ${ps.name}'s pickup rules` : ""}` }
}

// ------------------------------------------------------------------ facts

async function recordFact(ctx: RunCtx, input: FactInput): Promise<ToolOutcome> {
  const [info, known] = await Promise.all([resolveSources([input.sourceId]), facts(ctx)])
  const checked = checkFact(ctx.orderId, input, info.get(input.sourceId), known)
  if ("error" in checked) return { ok: false, summary: `Fact not recorded: ${checked.error}`, content: { error: checked.error } }
  const id = newId("fact")
  await db.insert(ringFacts).values({ id, runId: ctx.runId, ...checked.fact })
  if (checked.old) {
    if (checked.old.origin === "ring") await db.update(ringFacts).set({ level: checked.old.level, supersededByFactId: id }).where(and(eq(ringFacts.id, checked.old.id), isNull(ringFacts.supersededByFactId)))
    else await db.insert(ringMeta).values({ key: `supersede:${checked.old.id}`, value: { orderId: ctx.orderId, factId: id, level: checked.old.level } }).onConflictDoNothing()
  }
  const fact: Fact = { id, ...checked.fact }
  const oldClaim = checked.old && known.find((f) => f.id === checked.old!.id)?.claim
  if (checked.old && oldClaim) ctx.did.push(`Marked "${oldClaim.slice(0, 80)}" ${checked.old.level} (${fact.by}, ${hhmm(fact.at)})`)
  await ctx.emit({ type: "fact", fact })
  return {
    ok: true, content: { factId: id, level: fact.level, at: fact.at, overturned: checked.old },
    summary: `Recorded (${fact.level}): ${fact.claim}${checked.old ? ` — marks the earlier fact ${checked.old.level}` : ""}`,
  }
}

// ------------------------------------------------------------------ phone

function scenario(ctx: RunCtx) {
  const ps = site(ctx, pickupSiteId(b(ctx)))
  return ps ? { site: ps, sc: scenarioFor(ctx.orderId, ps) } : null
}

async function placeCall(ctx: RunCtx, input: { siteId: string; purpose: string; reconciled?: { callId: string; finding: string } }): Promise<ToolOutcome> {
  const bundle = b(ctx)
  const fail = (why: string) => ({ ok: false, summary: `Call not placed: ${why}`, content: { error: why } })
  if (!ctx.reads.order || !ctx.reads.messages) return fail("Read first: call read_order and read_messages before dialling.")
  if (ctx.liveCallId) return fail(`Call ${ctx.liveCallId} is still live. Hang up first.`)
  const allowed = pickupSiteId(bundle)
  if (input.siteId !== allowed) return fail(`Ringo may call only this order's pickup site or pickup contact${allowed ? ` (${allowed})` : ""}. Never a customer or a delivery contact.`)
  const s = scenario(ctx)!
  if (s.site.details.customer_id === bundle.customer.id) return fail("This pickup site belongs to the paying customer. Ringo never contacts a customer.")
  const ring = await ringFor(ctx.orderId)
  const prior = ring.calls.filter((c) => c.siteId === input.siteId && c.status === "ended")
  const last = ring.calls.filter((c) => c.status === "ended").pop()
  if (last && (last.outcome === "DROPPED_UNKNOWN" || last.outcome === "NO_ANSWER")) {
    if (!input.reconciled || input.reconciled.callId !== last.id) return fail(`The last call (${last.id}) ended ${last.outcome}. Re-read, then pass reconciled {callId: "${last.id}", finding} saying what you found.`)
    const lastRead = [ctx.reads.order, ctx.reads.messages].filter(Boolean).sort().pop()!
    if (Date.parse(lastRead) < Date.parse(last.endedAt ?? last.startedAt)) return fail("Re-read the order or messages after the dropped call before redialling.")
  }
  const { call, step } = await startCall({ runId: ctx.runId, orderId: ctx.orderId, siteName: s.site.name, scenario: s.sc, purpose: input.purpose, attempt: prior.length + 1, reconciledFrom: input.reconciled ?? null, ai: ctx.ai })
  for (const t of step.turns) await ctx.emit({ type: "call_turn", callId: call.id, turn: t })
  if (step.ended) await endCall(ctx, call)
  else ctx.liveCallId = call.id
  return { ok: true, content: { callId: call.id, number: call.number, heard: step.heard, ended: step.ended, outcome: step.outcome, said: step.turns.map((t) => t.text) },
    summary: `Dialled ${s.site.name} (${call.number}, simulated)${step.ended ? `: ${String(step.outcome).toLowerCase().replace(/_/g, " ")}` : ""}` }
}

async function endCall(ctx: RunCtx, call: CallRecord) {
  ctx.liveCallId = null
  const mins = Math.max(1, Math.round((Date.parse(call.endedAt ?? call.startedAt) - Date.parse(call.startedAt)) / 60000))
  ctx.did.push(`Called ${site(ctx, call.siteId)?.name ?? call.siteId}: ${String(call.outcome).toLowerCase().replace(/_/g, " ")} (${mins} min, simulated)`)
  await ctx.emit({ type: "call_ended", call })
}

async function callInput(ctx: RunCtx, input: { callId: string; press?: string; say?: string; wait?: boolean; hangup?: boolean }): Promise<ToolOutcome> {
  const fail = (why: string) => ({ ok: false, summary: `Call input refused: ${why}`, content: { error: why } })
  const actions = [input.press !== undefined, input.say !== undefined, input.wait === true, input.hangup === true].filter(Boolean).length
  if (actions !== 1) return fail("Pass exactly one of press, say, wait or hangup.")
  const call = await loadCall(input.callId)
  if (!call || call.orderId !== ctx.orderId || call.status !== "live") return fail("No live call with that id.")
  if (input.say) { const bad = checkSpeech(input.say); if (bad) return fail(bad) }
  const s = scenario(ctx)!
  const attempt = (await ringFor(ctx.orderId)).calls.filter((c) => c.siteId === call.siteId && c.startedAt <= call.startedAt).length
  const step = await callStep(call, s.sc, input, attempt, s.site.name, ctx.ai)
  for (const t of step.turns) await ctx.emit({ type: "call_turn", callId: call.id, turn: t })
  if (step.ended) await endCall(ctx, call)
  const heard = step.turns.filter((t) => t.speaker !== "ring").map((t) => t.text)
  const what = input.press !== undefined ? `Pressed ${input.press}` : input.say ? "Spoke" : input.wait ? "Waited" : "Hung up"
  return { ok: true, content: { heard: step.heard, ended: step.ended, outcome: step.outcome, lines: heard },
    summary: `${what}${step.ended ? `, call ended ${String(step.outcome).toLowerCase().replace(/_/g, " ")}` : `, now at ${step.heard}`}` }
}

// ------------------------------------------------------------------ driver

async function sendDriverMessage(ctx: RunCtx, input: { body: string; intent: "question" | "instruction" }): Promise<ToolOutcome> {
  const bundle = b(ctx)
  const asg = rows(bundle, "work_assignments").find((a) => a.details.status !== "CANCELLED")
  const driverId = typeof asg?.details.driver_id === "string" ? asg.details.driver_id : null
  if (!driverId || !asg) return { ok: false, summary: "No assigned driver on this order.", content: { error: "No assigned driver." } }
  const bad = checkSpeech(input.body)
  if (bad) return { ok: false, summary: `Message not sent: ${bad}`, content: { error: bad } }
  const name = bundle.dir.driverName(driverId) ?? driverId
  if (input.intent === "instruction") {
    const r = await doPropose(ctx, {
      command: "driver.instruct", actionType: "driver.instruct", targetType: "work_assignment", targetId: asg.id,
      payload: [{ key: "message", value: input.body }, { key: "driver_id", value: driverId }],
      rationale: "An instruction changes what the driver does, so a person approves it first.", summary: `Tell ${name}: ${input.body}`,
      evidenceRefs: [{ table: "work_assignments", id: asg.id }], onApprove: `The message is sent to ${name} (simulated driver chat).`, onReject: "Nothing is sent; the driver keeps the current plan.",
    })
    return r.ok ? { ...r, summary: `Instruction for ${name} waits for approval: ${input.body}` } : r
  }
  const now = await simNow()
  const out = { id: newId("dm"), runId: ctx.runId, orderId: ctx.orderId, driverId, direction: "out", intent: "question", body: input.body, proposalId: null, at: now }
  await db.insert(ringDriverMessages).values(out)
  await ctx.emit({ type: "driver_message", message: toDriverMessage(out) })
  const recent = ctx.loaded.messages.filter((m) => m.authorType === "driver").slice(-3).map((m) => m.body)
  const text = await driverReply({ driverName: name, question: input.body, scenario: scenario(ctx)?.sc ?? null, recent, ai: ctx.ai })
  const back = { id: newId("dm"), runId: ctx.runId, orderId: ctx.orderId, driverId, direction: "in", intent: "reply", body: text, proposalId: null, at: await simNow() }
  await db.insert(ringDriverMessages).values(back)
  await ctx.emit({ type: "driver_message", message: toDriverMessage(back) })
  ctx.did.push(`Asked driver ${name} (simulated chat)`)
  return { ok: true, content: { sentId: out.id, reply: { id: back.id, body: text } }, summary: `Asked ${name}; reply: "${text}"` }
}

// ------------------------------------------------------------------ proposals, callbacks, stop

type ProposeToolInput = {
  command: string; actionType: ActionType; targetType: string; targetId: string; alertId?: string
  payload: { key: string; value: string | boolean | string[] }[]; rationale: string; summary: string; evidenceRefs: SourceRef[]; onApprove: string; onReject: string
}

async function doPropose(ctx: RunCtx, input: ProposeToolInput): Promise<ToolOutcome> {
  ctx.proposeAttempts++
  if (ctx.proposeAttempts > LIMITS.proposeAttempts) return { ok: false, summary: "Proposal limit reached for this run.", content: { error: "Limit of 3 proposal attempts reached. Stop with needs_person." } }
  const known = await resolveSources(input.evidenceRefs.map((r) => r.id))
  const missing = input.evidenceRefs.filter((r) => !known.has(r.id))
  if (missing.length) return { ok: false, summary: `Proposal refused: unknown evidence ${missing.map((m) => m.id).join(", ")}`, content: { error: `These evidence ids do not exist: ${missing.map((m) => m.id).join(", ")}` } }
  const payload = Object.fromEntries(input.payload.map(({ key, value }) => [key, value === "true" ? true : value === "false" ? false : value]))
  const r = await propose(b(ctx), ctx.runId, { ...input, alertId: input.alertId ?? null, payload })
  if ("blocked" in r) {
    if (r.blocked) await ctx.emit({ type: "gate", command: input.command, result: r.blocked })
    const why = r.blocked?.findings.filter((f) => f.effect === "block").map((f) => `${f.ruleId} ${f.message}`).join("; ") || r.reason
    return { ok: false, summary: `Proposal blocked: ${why}`, content: { blocked: r.blocked?.findings ?? [], reason: r.reason } }
  }
  await ctx.emit({ type: "gate", command: input.command, result: r.proposal.gate! })
  await ctx.emit({ type: "proposal", proposal: r.proposal })
  const auto = r.proposal.trustMode === "auto"
  ctx.did.push(auto ? `Recorded: ${r.proposal.summary}` : `Proposed: ${r.proposal.summary}`)
  return { ok: true, content: { proposalId: r.proposal.id, status: r.proposal.status, trustMode: r.proposal.trustMode, conditions: r.proposal.gate?.findings ?? [], execution: r.execution },
    summary: auto ? `Done without approval (trusted): ${r.proposal.summary}` : `Proposal waits for a person: ${r.proposal.summary}` }
}

async function scheduleCallback(ctx: RunCtx, input: { dueAt: string; reason: string }): Promise<ToolOutcome> {
  const now = await simNow()
  const s = scenario(ctx)
  const due = new Date(input.dueAt)
  if (Number.isNaN(due.getTime()) || due.getTime() <= Date.parse(now)) return { ok: false, summary: "Callback refused: the time must be in the future.", content: { error: `dueAt must be after ${now}.` } }
  if (s && !isOpen(s.sc.ivr.openingHours, s.sc.ivr.timezone, due.toISOString())) return { ok: false, summary: "Callback refused: the site is closed then.", content: { error: `The site is closed at that time. Hours: ${JSON.stringify(s.sc.ivr.openingHours)} (${s.sc.ivr.timezone}).` } }
  const job = { id: newId("job"), orderId: ctx.orderId, dueAt: due.toISOString(), reason: input.reason, status: "scheduled" as const, createdByRunId: ctx.runId, firedRunId: null }
  await db.insert(ringJobs).values(job)
  await ctx.emit({ type: "callback_scheduled", job })
  ctx.did.push(`Scheduled a callback for ${hhmm(job.dueAt)}`)
  return { ok: true, content: { jobId: job.id, dueAt: job.dueAt }, summary: `Callback scheduled for ${hhmm(job.dueAt)}: ${input.reason}` }
}

async function stopWithDecision(ctx: RunCtx, input: StopDecision): Promise<ToolOutcome> {
  const fail = (why: string) => ({ ok: false, summary: `Cannot stop yet: ${why}`, content: { error: why } })
  if (ctx.liveCallId) return fail("Hang up the live call first.")
  if (input.headline.length > 120) return fail("headline must be at most 120 characters.")
  const ring = await ringFor(ctx.orderId)
  const ids = new Set((await facts(ctx, ring)).map((f) => f.id))
  const bad = input.found.filter((id) => !ids.has(id))
  if (bad.length) return fail(`These are not fact ids on this order: ${bad.join(", ")}`)
  const pending = ring.proposals.filter((p) => p.status === "PENDING_REVIEW")
  if (input.outcome === "proposal_ready" && !pending.length) return fail("proposal_ready needs at least one pending proposal.")
  // ponytail: "did" is built from what the tools actually did, never from the model's own account of it.
  const noted = (await db.select({ id: ringFacts.id }).from(ringFacts).where(eq(ringFacts.runId, ctx.runId))).length
  ctx.stopped = { ...input, did: [...ctx.did, ...(noted ? [`Wrote down ${noted} fact${noted === 1 ? "" : "s"}, each with its source`] : [])] }
  return { ok: true, content: { stopped: true }, summary: `Stopped: ${input.headline}` }
}

export async function runTool(ctx: RunCtx, name: ToolName, input: Record<string, unknown>): Promise<ToolOutcome> {
  const schema = TOOLS.find((t) => t.name === name)?.input_schema as { required?: string[]; properties?: Record<string, { type?: unknown }> } | undefined
  const missing = (schema?.required ?? []).filter((k) => input[k] === undefined || (input[k] === null && !String(schema?.properties?.[k]?.type).includes("null")))
  if (missing.length) return { ok: false, summary: `Missing ${missing.join(", ")}.`, content: { error: `Missing required fields: ${missing.join(", ")}` } }
  for (const k of ["found", "did", "options", "evidenceRefs", "payload"]) if (k in input && !Array.isArray(input[k])) return { ok: false, summary: `${k} must be a list.`, content: { error: `${k} must be an array.` } }
  if (typeof input.orderId === "string" && input.orderId !== ctx.orderId) return { ok: false, summary: "Wrong order id.", content: { error: `This run is for ${ctx.orderId}.` } }
  switch (name) {
    case "read_order": return readOrder(ctx)
    case "read_messages": return readMessages(ctx, input as { sinceIso?: string })
    case "read_docs": return readDocs(ctx)
    case "record_fact": return recordFact(ctx, input as unknown as FactInput)
    case "place_call": return placeCall(ctx, input as { siteId: string; purpose: string })
    case "call_input": return callInput(ctx, input as { callId: string })
    case "send_driver_message": return sendDriverMessage(ctx, input as { body: string; intent: "question" })
    case "propose_action": return doPropose(ctx, input as unknown as ProposeToolInput)
    case "schedule_callback": return scheduleCallback(ctx, input as { dueAt: string; reason: string })
    case "stop_with_decision": return stopWithDecision(ctx, input as unknown as StopDecision)
    default: return { ok: false, summary: `Unknown tool ${name}`, content: { error: "Unknown tool." } }
  }
}
