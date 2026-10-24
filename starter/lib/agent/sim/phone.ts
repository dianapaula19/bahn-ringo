// Seller-Sim: walks a fixed IVR tree in code. Only the person at the end of a
// menu is played by the model, from a hidden persona script. Simulated.
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import type { CallOutcome, CallRecord, CallTurn, IvrNode, IvrNodeKind, SimPersona, SimScenario } from "@/lib/contract"
import { ringCalls } from "@/lib/ring-schema"
import { newId, simNow } from "../clock"
import { shortReply, type AiTraceContext } from "../llm"
import { toCall } from "../store"

export const MAX_INPUTS = 14

/** Is the site open at `now` in its own time zone? Hours look like {mon_fri: "08:30-19:00", sat: "...", sun: null}. */
export function isOpen(hours: Record<string, string | null>, tz: string, now: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now))
  const day = parts.find((p) => p.type === "weekday")!.value.slice(0, 3).toLowerCase()
  const hm = `${parts.find((p) => p.type === "hour")!.value}:${parts.find((p) => p.type === "minute")!.value}`
  const key = ["mon", "tue", "wed", "thu", "fri"].includes(day) ? "mon_fri" : day
  const range = hours[key] ?? hours[day]
  if (!range) return false
  const [open, close] = range.split("-")
  return hm >= open && hm < close
}

type Step = { turns: CallTurn[]; heard: IvrNodeKind; ended: boolean; outcome: CallOutcome | null }

async function save(call: CallRecord) {
  await db.update(ringCalls).set({
    status: call.status, outcome: call.outcome, ivrPath: call.ivrPath, transcript: call.transcript, endedAt: call.endedAt,
  }).where(eq(ringCalls.id, call.id))
}

const turn = async (speaker: CallTurn["speaker"], text: string, extra: Partial<CallTurn> = {}): Promise<CallTurn> => ({ at: await simNow(), speaker, text, ...extra })

function personaSystem(p: SimPersona, siteName: string): string {
  return [
    `You are ${p.name}, ${p.role} at ${siteName}. This is a simulated phone call in a training system for a car delivery company; the caller is "Ringo", the company's pickup readiness assistant.`,
    `Speak ${({ en: "English", de: "German", fi: "Finnish", da: "Danish" })[p.language]}. At most 2 short sentences per reply. Style: ${p.style}`,
    "Answer only from what you know below. For anything else say you can't confirm that. Never invent names, phone numbers, addresses, times or prices.",
    `What you know:\n- ${p.knows.join("\n- ")}`,
    `What you do not know (say you can't confirm it):\n- ${p.doesNotKnow.join("\n- ")}`,
    "Reply with only your spoken words.",
  ].join("\n\n")
}

async function personaReply(p: SimPersona, siteName: string, call: CallRecord, ai: AiTraceContext | null): Promise<string> {
  const since = call.transcript.findLastIndex((t) => t.speaker === "ivr")
  const lines = call.transcript.slice(since + 1).map((t) => `${t.speaker === "ring" ? "Caller" : "You"}: ${t.text}`).join("\n")
  const text = await shortReply(personaSystem(p, siteName), lines ? `The call so far:\n${lines}\n\nYour reply:` : "You pick up the phone. Greet the caller with your name and role.", "low", ai ?? undefined)
  return text ?? "Sorry, the line is breaking up. Could you call back?"
}

/** Enter a node: what the caller hears, plus any scripted twist for this attempt. */
async function enter(call: CallRecord, sc: SimScenario, node: IvrNode, attempt: number, siteName: string, ai: AiTraceContext | null): Promise<Step> {
  call.ivrPath.push(node.id)
  const twist = sc.script.find((s) => s.attempt === attempt && s.atNode === node.id)
  const turns: CallTurn[] = []
  if (node.kind === "hold") turns.push(await turn("ivr", node.prompt, { heard: "hold", nodeId: node.id }))
  if (twist?.event === "drop") {
    turns.push(await turn("system", "The line went silent during the transfer and then disconnected. Nobody confirmed anything.", { heard: "dropped", nodeId: node.id }))
    return finish(call, turns, "DROPPED_UNKNOWN", "dropped")
  }
  if (twist?.event === "voicemail" || node.kind === "voicemail") {
    turns.push(await turn("ivr", node.kind === "voicemail" ? node.prompt : "Nobody is available. Please leave a message after the tone.", { heard: "voicemail", nodeId: node.id }))
    return { turns, heard: "voicemail", ended: false, outcome: null }
  }
  if (node.kind === "closed") {
    turns.push(await turn("ivr", node.prompt, { heard: "closed", nodeId: node.id }))
    return finish(call, turns, "CLOSED", "closed")
  }
  if (node.kind === "menu") turns.push(await turn("ivr", node.prompt, { heard: "menu", nodeId: node.id }))
  if (node.kind === "human") {
    const p = sc.personas.find((x) => x.id === node.personaId)!
    turns.push(await turn("site", await personaReply(p, siteName, call, ai), { heard: "human", nodeId: node.id }))
  }
  return { turns, heard: node.kind, ended: false, outcome: null }
}

function finish(call: CallRecord, turns: CallTurn[], outcome: CallOutcome, heard: IvrNodeKind): Step {
  call.status = "ended"
  call.outcome = outcome
  call.endedAt = turns[turns.length - 1]?.at ?? call.startedAt
  return { turns, heard, ended: true, outcome }
}

export async function startCall(input: {
  runId: string; orderId: string; siteName: string; scenario: SimScenario; purpose: string; attempt: number
  reconciledFrom: CallRecord["reconciledFrom"]; ai: AiTraceContext | null
}): Promise<{ call: CallRecord; step: Step }> {
  const now = await simNow()
  const { ivr } = input.scenario
  const call: CallRecord = {
    id: newId("call"), runId: input.runId, orderId: input.orderId, siteId: ivr.siteId, number: ivr.number, purpose: input.purpose,
    status: "live", outcome: null, ivrPath: [], transcript: [], startedAt: now, endedAt: null, reconciledFrom: input.reconciledFrom, simulated: true,
  }
  await db.insert(ringCalls).values({ ...call, ivrPath: [], transcript: [] })
  const open = isOpen(ivr.openingHours, ivr.timezone, now)
  const step = await enter(call, input.scenario, ivr.nodes[open ? ivr.root : ivr.closedNode], input.attempt, input.siteName, input.ai)
  call.transcript.push(...step.turns)
  await save(call)
  return { call, step }
}

export type CallAction = { press?: string; say?: string; wait?: boolean; hangup?: boolean }

export async function callStep(call: CallRecord, sc: SimScenario, action: CallAction, attempt: number, siteName: string, ai: AiTraceContext | null): Promise<Step> {
  const node = sc.ivr.nodes[call.ivrPath[call.ivrPath.length - 1]]
  const turns: CallTurn[] = []
  const inputs = call.transcript.filter((t) => t.speaker === "ring").length
  let step: Step
  if (action.hangup) {
    turns.push(await turn("ring", "(hangs up)"))
    const spoke = call.transcript.some((t) => t.speaker === "site")
    step = finish(call, turns, spoke ? "ANSWERED" : node.kind === "voicemail" ? "VOICEMAIL" : "NO_ANSWER", node.kind)
  } else if (inputs >= MAX_INPUTS) {
    turns.push(await turn("system", "Call limit reached; Ringo ended the call."))
    step = finish(call, turns, call.transcript.some((t) => t.speaker === "site") ? "ANSWERED" : "NO_ANSWER", node.kind)
  } else if (action.press !== undefined) {
    turns.push(await turn("ring", `Pressed ${action.press}`, { dtmf: action.press }))
    const opt = node.kind === "menu" ? node.options?.find((o) => o.digit === action.press) : undefined
    if (!opt) {
      turns.push(await turn("ivr", node.kind === "menu" ? `That is not a valid option. ${node.prompt}` : "(no response to the key press)", { heard: node.kind, nodeId: node.id }))
      step = { turns, heard: node.kind, ended: false, outcome: null }
    } else {
      const next = await enter(call, sc, sc.ivr.nodes[opt.next], attempt, siteName, ai)
      step = { ...next, turns: [...turns, ...next.turns] }
    }
  } else if (action.say !== undefined) {
    turns.push(await turn("ring", action.say))
    call.transcript.push(...turns)
    if (node.kind === "human") {
      const p = sc.personas.find((x) => x.id === node.personaId)!
      const reply = await turn("site", await personaReply(p, siteName, call, ai), { heard: "human", nodeId: node.id })
      call.transcript.push(reply)
      await save(call)
      return { turns: [...turns, reply], heard: "human", ended: false, outcome: null }
    }
    if (node.kind === "voicemail") {
      const end = await turn("system", "Message recorded on voicemail.")
      call.transcript.push(end)
      const s = finish(call, [end], "VOICEMAIL", "voicemail")
      await save(call)
      return { ...s, turns: [...turns, end] }
    }
    const t = await turn("ivr", `Sorry, I didn't get that. ${node.prompt}`, { heard: node.kind, nodeId: node.id })
    call.transcript.push(t)
    await save(call)
    return { turns: [...turns, t], heard: node.kind, ended: false, outcome: null }
  } else {
    turns.push(await turn("ring", "(waits)"))
    if (node.kind === "hold" && node.next) {
      const next = await enter(call, sc, sc.ivr.nodes[node.next], attempt, siteName, ai)
      step = { ...next, turns: [...turns, ...next.turns] }
    } else if (node.kind === "menu") {
      turns.push(await turn("ivr", node.prompt, { heard: "menu", nodeId: node.id }))
      step = { turns, heard: "menu", ended: false, outcome: null }
    } else {
      turns.push(await turn("system", "Silence on the line."))
      step = { turns, heard: node.kind, ended: false, outcome: null }
    }
  }
  call.transcript.push(...step.turns)
  await save(call)
  return step
}

export async function loadCall(id: string): Promise<CallRecord | null> {
  const [row] = await db.select().from(ringCalls).where(eq(ringCalls.id, id))
  return row ? toCall(row) : null
}
