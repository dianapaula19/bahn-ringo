// Ringo's tool loop: Anthropic SDK, streamed, hand-written so guards and limits
// run between turns. Every RunEvent is persisted to ring_steps and passed to
// `onEvent` (the NDJSON stream, or a script's log).
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import Anthropic from "@anthropic-ai/sdk"
import { db } from "@/lib/db"
import type { RunEvent, RunSummary, RunTrigger, StopDecision, ToolName } from "@/lib/contract"
import { loadOrder } from "@/lib/present/load"
import { ringRuns, ringSteps } from "@/lib/ring-schema"
import { ringEligibility } from "@/lib/triage/triage"
import { newId, simNow } from "./clock"
import { anthropic, BETAS, captureAiGeneration, captureAiToolSpan, flushAiObservability, MODEL, newAiTrace } from "./llm"
import { LIMITS, runTool, TOOLS, type RunCtx, type ToolOutcome } from "./tools"

export const SYSTEM = `You are Ringo, the pickup readiness agent in a car delivery control room. Your job on one order: find out whether the car can be collected (who has the keys, where the handover is, who releases it, which papers are needed), write down what you learn as graded facts, and then either finish or bring a person one clear decision.

Hard rules (code also enforces them; a refused tool call tells you why):
- Never contact a customer or a delivery contact. You may call only the order's pickup site or pickup contact, and message only the assigned driver.
- Read before you dial: call read_order, read_messages and read_playbook (the site's notes from earlier calls) first. Use what is already on record; do not re-ask a question the record already answers.
- Reconcile before you retry: if a call dropped or went unanswered, its outcome is unknown. Re-read (read_order, read_messages) and check nothing changed, then schedule_callback at least 10 minutes later within the site's opening hours and stop with outcome "waiting". Do not redial in the same run. A callback run redials with place_call.reconciled naming the dropped call and what the re-read found. After two calls in a row that reached no one, do not book another callback: stop with needs_person.
- A quote is not a booking, a booking is not a movement, a claim is not a fact. Record facts with record_fact at the right level: claimed (someone said it: customer, driver, order note, site profile), quoted (the site said it about this car, on a call or in a message), reserved (a booking record), observed (a physical signal). Never verified. Cite the exact source id (a message id, a ring call id, an endpoint detail id). When a later source contradicts an earlier fact, record the new fact with supersedesFactId and effect "refutes".
- No mechanical advice, no diagnosis, no blame. No promises on the phone ("we will", "guaranteed", "it is booked").
- Prepare, don't cancel. Never cancel or double-book.
- Stop when the next step needs a customer, money, a date or a booking: propose it for a person, or stop with needs_person and say what the person must decide.

How to work:
1. read_order, read_messages (read_docs when papers or site rules matter).
2. Before any call, record what the record already says about the gap, so a person sees what was believed and what overturned it: each customer message or order note that makes a claim about keys, access, contact or address becomes a claimed fact (cite the message or note id). If a later site statement on record contradicts one, record that statement (cite its message id, level quoted) with supersedesFactId = the claimed fact and effect "refutes". Do not ask the site again about something the record already settled.
3. Calling the pickup site is your job and needs no approval. If the open gap is something a person at the site can answer (who holds the keys, who releases the car, where the handover is, a direct contact, the street address, whether the car is in stock), place_call to the pickup site and walk the menu with call_input: press digits, wait on hold, speak briefly and politely, give the order reference, ask one thing at a time, hang up when done. Pick the menu option that reaches the person who can answer; do not re-ask someone the record says cannot answer.
   Calls in detail:
   - Playbook: read_playbook before you dial. Start from it: if it knows the menu path, press the digits in one go (e.g. press "32"), and ask for the person it names. It is about the site, not this car: confirm anything about this car on the call, and never cite the playbook for a fact on this order.
   - Language: the site answers in its own language (German, Danish, Finnish or English). Speak that language to the menu's people. Record claims in English, and pass quote with the site's exact words in the original language.
   - Ladder: every place_call names its rung: site_desk, stock_control, branch_manager. Start at the desk, or at stock control when the record or playbook says they hold the answer. Climb one rung only when the rung below could not answer, and say why in place_call.why. Never climb on a safety case. A refused call starting "Ladder stop:" is final for this run: do not redial or try another rung around it. If the site is closed, schedule_callback in its opening hours; otherwise stop and say what the person should decide.
   - After a call where someone spoke, note_playbook once: who answered which line, where keys live, handover rules, quirks, each with the exact quote. The menu path is written for you. If an earlier site statement on record is a clear block that only the customer or seller can lift (for example a seller hold or a missing signed release), do not call and propose nothing: record the block as a fact and stop with needs_person, saying the person decides whether and how to contact the customer.
4. Record what the site said as quoted facts citing the call id.
5. Propose record changes with propose_action (endpoint.record_access, endpoint.record_contact, driver.instruct, pickup.hold). A street address is customer input: propose it only as address.update, with onApprove saying a person confirms it with the customer first; never put an address into another proposal. Write onApprove/onReject as one plain sentence each.
- If the assigned driver is waiting at the pickup, ask them first (send_driver_message, intent question) whether they are still there and what the site told them. Anything that changes what the driver does (leave, wait longer, go elsewhere) is an instruction: send it with intent instruction so a person approves it.
6. End every run with stop_with_decision: a headline (max 120 characters), the one decision for a person in one sentence (or null), the fact ids you found, what you did (short past-tense lines), and whatNext in one sentence.

Speak to people in plain, short sentences. Write all text for an operations person, not an engineer.`

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function liveRun(orderId: string): Promise<string | null> {
  const [row] = await db.select().from(ringRuns).where(and(eq(ringRuns.orderId, orderId), eq(ringRuns.status, "running")))
  // A run "running" for more than 10 minutes (sim clock) died with its process.
  const now = await simNow()
  if (row && Date.parse(now) - Date.parse(row.startedAt) > 10 * 60_000 * (Number(process.env.RING_CLOCK_SPEED ?? 1) || 1)) {
    await db.update(ringRuns).set({ status: "failed", error: "Run stopped without finishing.", endedAt: now }).where(eq(ringRuns.id, row.id))
    return null
  }
  return row?.id ?? null
}

/** Stream a recorded fixture (lib/agent/fixtures/<reference>.ndjson), 300 ms per event. Not persisted. */
export async function replay(orderId: string, onEvent: (e: RunEvent) => void | Promise<void>): Promise<void> {
  const loaded = await loadOrder(orderId)
  const at = await simNow()
  const ref = loaded?.order.reference ?? orderId
  let lines: string[]
  try {
    lines = (await readFile(join(process.cwd(), "lib", "agent", "fixtures", `${ref}.ndjson`), "utf8")).split("\n").filter((l) => l.trim())
  } catch {
    await onEvent({ type: "error", message: `No recorded run for ${ref} yet.`, retryable: false, at })
    await onEvent({ type: "run_ended", runId: "replay", status: "failed", at })
    return
  }
  for (const line of lines) {
    const e = JSON.parse(line) as RunEvent
    await onEvent(e.type === "run_started" ? { ...e, replay: true, trigger: "replay" } : e)
    await pause(300)
  }
}

export async function runRing(input: {
  orderId: string; trigger: RunTrigger; message?: string | null; runId?: string
  onEvent?: (e: RunEvent) => void | Promise<void>
}): Promise<RunSummary> {
  const client = anthropic()
  const startedAt = await simNow()
  const runId = input.runId ?? newId("run")
  const onEvent = input.onEvent ?? (() => {})
  if (!client) {
    const err: RunEvent = { type: "error", message: "Ringo is offline: no model key", retryable: false, at: startedAt }
    await onEvent(err)
    await onEvent({ type: "run_ended", runId, status: "failed", at: startedAt })
    return { id: runId, orderId: input.orderId, trigger: input.trigger, status: "failed", startedAt, endedAt: startedAt, model: MODEL, decision: null, error: err.message, operatorMessage: input.message ?? null }
  }
  const loaded = await loadOrder(input.orderId)
  if (!loaded) throw new Error(`Order ${input.orderId} not found`)
  await db.insert(ringRuns).values({ id: runId, orderId: input.orderId, trigger: input.trigger, status: "running", model: MODEL, operatorMessage: input.message ?? null, startedAt })
  let seq = 0
  const emit = async (e: RunEvent) => {
    await db.insert(ringSteps).values({ runId, seq: seq++, event: e })
    await onEvent(e)
  }
  const ctx: RunCtx = { runId, orderId: input.orderId, loaded, emit, reads: { order: null, messages: null, docs: null }, playbooks: new Map(), liveCallId: null, proposeAttempts: 0, toolCalls: 0, did: [], stopped: null, ai: null }
  await emit({ type: "run_started", runId, orderId: input.orderId, trigger: input.trigger, at: startedAt, model: MODEL, replay: false })

  let status: RunSummary["status"] = "stopped"
  let error: string | null = null
  const eligibility = ringEligibility(loaded.bundle)
  try {
    if (!eligibility.ok) {
      ctx.stopped = forcedStop(eligibility.reason ?? "Not a Ringo order.", [], "This order needs a person.")
    } else {
      await loop(client, ctx, input)
    }
    if (ctx.liveCallId) await runTool(ctx, "call_input", { callId: ctx.liveCallId, hangup: true })
  } catch (e) {
    status = "failed"
    error = e instanceof Anthropic.APIError ? `Model error ${e.status ?? ""}: ${e.message.slice(0, 300)}` : e instanceof Error ? e.message : String(e)
    await emit({ type: "error", message: `Ringo stopped: ${error}`, retryable: e instanceof Anthropic.APIError && (e.status === 429 || (e.status ?? 0) >= 500), at: await simNow() })
    // outcome "failed" keeps the order's real decision card: a broken run is not a decision for a person.
    ctx.stopped = { ...forcedStop(e instanceof Anthropic.APIError ? "Ringo couldn't reach his model and stopped." : "Ringo hit a problem and stopped.", ctx.did, "Try again or work it by hand."), outcome: "failed", oneDecision: null }
  }
  const decision = ctx.stopped!
  const endedAt = await simNow()
  await emit({ type: "stop", decision, at: endedAt })
  await db.update(ringRuns).set({ status, decision, error, endedAt }).where(eq(ringRuns.id, runId))
  await emit({ type: "run_ended", runId, status, at: endedAt })
  await flushAiObservability()
  return { id: runId, orderId: input.orderId, trigger: input.trigger, status, startedAt, endedAt, model: MODEL, decision, error, operatorMessage: input.message ?? null }
}

function forcedStop(headline: string, did: string[], whatNext: string): StopDecision {
  return { outcome: "needs_person", headline: headline.slice(0, 120), oneDecision: headline, options: [], found: [], did, whatNext, nextCheckAt: null, ownerDesk: "ops-readiness" }
}

async function loop(client: Anthropic, ctx: RunCtx, input: { orderId: string; trigger: RunTrigger; message?: string | null }) {
  const now = await simNow()
  const first = [
    `Order: ${ctx.loaded.order.reference} (id ${input.orderId}). Time now: ${now}.`,
    input.trigger === "callback" ? "This is a scheduled callback run." : input.trigger === "triage" ? "Triage sent you here." : "A person asked you to work this order.",
    input.message ? `Message from the operator: ${input.message}` : null,
  ].filter(Boolean).join("\n")
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: first }]
  let nudges = 0
  for (;;) {
    if (ctx.toolCalls >= LIMITS.toolCalls) {
      ctx.stopped = forcedStop("Ringo reached his step limit before finishing. A person should take over.", ctx.did, "Read Ringo's notes on this order and decide the next step.")
      return
    }
    ctx.ai = newAiTrace(ctx.runId)
    const turnStartedAt = Date.now()
    const stream = client.beta.messages.stream({
      model: MODEL, max_tokens: 16000, betas: BETAS, fallbacks: "default",
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: TOOLS as Anthropic.Beta.BetaTool[], tool_choice: { type: "auto" },
      thinking: { type: "adaptive" }, output_config: { effort: "medium" }, messages,
    } as Anthropic.Beta.MessageCreateParamsStreaming)
    const msg = await stream.finalMessage().catch((e) => { captureAiGeneration(ctx.ai, "ringo_turn", turnStartedAt, null, e); throw e })
    captureAiGeneration(ctx.ai, "ringo_turn", turnStartedAt, msg)
    if (msg.stop_reason === "refusal") {
      ctx.stopped = forcedStop("Ringo could not continue on this order. A person should take over.", ctx.did, "Work the order by hand.")
      return
    }
    messages.push({ role: "assistant", content: msg.content })
    for (const block of msg.content) if (block.type === "text" && block.text.trim()) await ctx.emit({ type: "progress", text: block.text.trim(), at: await simNow() })
    const uses = msg.content.filter((c): c is Anthropic.Beta.BetaToolUseBlock => c.type === "tool_use")
    if (!uses.length) {
      if (msg.stop_reason === "max_tokens" || nudges++ >= 2) {
        ctx.stopped = forcedStop("Ringo ended without a clear decision. A person should look.", ctx.did, "Read Ringo's notes on this order.")
        return
      }
      messages.push({ role: "user", content: "End the run with stop_with_decision." })
      continue
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const use of uses) {
      ctx.toolCalls++
      const stepId = newId("step")
      const name = use.name as ToolName
      const toolInput = (use.input ?? {}) as Record<string, unknown>
      await ctx.emit({ type: "tool_call", stepId, tool: name, input: toolInput, at: await simNow() })
      const over = ctx.toolCalls > LIMITS.toolCalls
      const toolStartedAt = Date.now()
      let out: ToolOutcome
      try {
        out = over ? { ok: false, summary: "Step limit reached.", content: { error: "Step limit reached. Call stop_with_decision now." } } : await runTool(ctx, name, toolInput)
      } catch (error) {
        captureAiToolSpan(ctx.ai, name, toolInput, null, toolStartedAt, true)
        throw error
      }
      captureAiToolSpan(ctx.ai, name, toolInput, out.content, toolStartedAt)
      await ctx.emit({ type: "tool_result", stepId, tool: name, ok: out.ok, summary: out.summary, at: await simNow() })
      results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(out.content), is_error: !out.ok })
    }
    messages.push({ role: "user", content: results })
    if (ctx.stopped) return
  }
}
