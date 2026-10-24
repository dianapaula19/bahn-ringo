// Seller-Sim: walks a fixed IVR tree in code. Only the person at the end of a
// menu is played by the model, from a hidden persona script. Simulated.
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import type { CallOutcome, CallRecord, IvrNodeKind, SimPersona, SimScenario } from "@/lib/contract"
import { ringCalls } from "@/lib/ring-schema"
import { newId, simNow } from "../clock"
import { shortReply, type AiTraceContext } from "../llm"
import { toCall } from "../store"
import { LANG_NAME, type Lang, type Turn } from "./calls"
import { LINE, type Node } from "./scenarios"

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

type Step = { turns: Turn[]; heard: IvrNodeKind; ended: boolean; outcome: CallOutcome | null }

async function save(call: CallRecord) {
  await db.update(ringCalls).set({
    status: call.status, outcome: call.outcome, ivrPath: call.ivrPath, transcript: call.transcript, endedAt: call.endedAt,
  }).where(eq(ringCalls.id, call.id))
}

const turn = async (speaker: Turn["speaker"], text: string, extra: Partial<Turn> = {}): Promise<Turn> => ({ at: await simNow(), speaker, text, ...extra })
/** What the phone menu says at a node, with its written English and its label for the path diagram. */
const ivrTurn = (node: Node, heard: IvrNodeKind, text = node.prompt, en = node.en) =>
  turn("ivr", text, { heard, nodeId: node.id, lang: node.language, label: node.label, ...(en && node.language !== "en" ? { en } : {}), ...(node.kind === "hold" ? { seconds: node.seconds } : {}) })

/** One line of the call into English (model, effort low). Null when there is nothing to translate; undefined when the model gave none. */
export async function translate(text: string, from: Lang, ai: AiTraceContext | null): Promise<string | null | undefined> {
  if (from === "en" || !text.trim()) return null
  const en = (await shortReply(`You translate one line of a simulated phone call from ${LANG_NAME[from]} into plain English. Keep names, numbers, times, codes and e-mail handles exactly as they are. If the line is already English, repeat it unchanged. Reply with only the English line.`, text, "low", ai ?? undefined))?.trim()
  if (!en) return undefined
  return en !== text.trim() ? en : null
}

function personaSystem(p: SimPersona, siteName: string): string {
  return [
    `You are ${p.name}, ${p.role} at ${siteName}. This is a simulated phone call in a training system for a car delivery company; the caller is "Ringo", the company's pickup readiness assistant.`,
    `Speak ${LANG_NAME[p.language]} only, even if the caller uses another language. At most 2 short sentences per reply. Style: ${p.style}`,
    "Answer only from what you know below. For anything else say you can't confirm that. Never invent names, phone numbers, addresses, times or prices.",
    `What you know:\n- ${p.knows.join("\n- ")}`,
    `What you do not know (say you can't confirm it):\n- ${p.doesNotKnow.join("\n- ")}`,
    "Reply with only your spoken words.",
  ].join("\n\n")
}

async function personaReply(p: SimPersona, siteName: string, call: CallRecord, ai: AiTraceContext | null): Promise<string> {
  const since = call.transcript.findLastIndex((t) => t.speaker === "ivr")
  const lines = call.transcript.slice(since + 1).map((t) => `${t.speaker === "ring" ? "Caller" : "You"}: ${t.text}`).join("\n")
  const text = await shortReply(personaSystem(p, siteName), lines ? `The call so far:\n${lines}\n\nYour reply:` : "You pick up the phone. Greet the caller with your first name and role.", "low", ai ?? undefined)
  return text ?? "Sorry, the line is breaking up. Could you call back?"
}

/** The person on the line answers, in their language, with an English translation alongside. */
async function personTurn(p: SimPersona, node: Node, siteName: string, call: CallRecord, ai: AiTraceContext | null): Promise<Turn> {
  const text = await personaReply(p, siteName, call, ai)
  const en = await translate(text, p.language, ai)
  return turn("site", text, { heard: "human", nodeId: node.id, lang: p.language, who: `${p.name}, ${p.role}`, label: node.label, ...(en ? { en } : {}) })
}

/** Enter a node: what the caller hears, plus any scripted twist for this attempt. */
async function enter(call: CallRecord, sc: SimScenario, node: Node, attempt: number, siteName: string, ai: AiTraceContext | null): Promise<Step> {
  call.ivrPath.push(node.id)
  const twist = sc.script.find((s) => s.attempt === attempt && s.atNode === node.id)
  const turns: Turn[] = []
  if (node.kind === "hold") turns.push(await ivrTurn(node, "hold"))
  if (twist?.event === "drop") {
    turns.push(await turn("system", "The line went silent during the transfer and then disconnected. Nobody confirmed anything.", { heard: "dropped", nodeId: node.id }))
    return finish(call, turns, "DROPPED_UNKNOWN", "dropped")
  }
  if (twist?.event === "voicemail" || node.kind === "voicemail") {
    turns.push(await (node.kind === "voicemail" ? ivrTurn(node, "voicemail") : ivrTurn(node, "voicemail", LINE[node.language].nobody, LINE.en.nobody)))
    return { turns, heard: "voicemail", ended: false, outcome: null }
  }
  if (node.kind === "closed") {
    turns.push(await ivrTurn(node, "closed"))
    return finish(call, turns, "CLOSED", "closed")
  }
  if (node.kind === "menu") turns.push(await ivrTurn(node, "menu"))
  if (node.kind === "human") turns.push(await personTurn(sc.personas.find((x) => x.id === node.personaId)!, node, siteName, call, ai))
  return { turns, heard: node.kind, ended: false, outcome: null }
}

function finish(call: CallRecord, turns: Turn[], outcome: CallOutcome, heard: IvrNodeKind): Step {
  call.status = "ended"
  call.outcome = outcome
  call.endedAt = turns[turns.length - 1]?.at ?? call.startedAt
  return { turns, heard, ended: true, outcome }
}

export async function startCall(input: {
  runId: string; orderId: string; siteName: string; scenario: SimScenario; purpose: string; attempt: number
  reconciledFrom: CallRecord["reconciledFrom"]; ai: AiTraceContext | null
  /** System turns that open the transcript: the rung this call is for, the playbook it starts from. */
  preface: Turn[]
}): Promise<{ call: CallRecord; step: Step }> {
  const now = await simNow()
  const { ivr } = input.scenario
  const call: CallRecord = {
    id: newId("call"), runId: input.runId, orderId: input.orderId, siteId: ivr.siteId, number: ivr.number, purpose: input.purpose,
    status: "live", outcome: null, ivrPath: [], transcript: [...input.preface], startedAt: now, endedAt: null, reconciledFrom: input.reconciledFrom, simulated: true,
  }
  await db.insert(ringCalls).values({ ...call, ivrPath: [] })
  const open = isOpen(ivr.openingHours, ivr.timezone, now)
  const step = await enter(call, input.scenario, ivr.nodes[open ? ivr.root : ivr.closedNode], input.attempt, input.siteName, input.ai)
  call.transcript.push(...step.turns)
  await save(call)
  return { call, step: { ...step, turns: [...input.preface, ...step.turns] } }
}

/** `press` may hold several digits (type-ahead from a known menu path); `sayEn` is the English of `say`. */
export type CallAction = { press?: string; say?: string; sayEn?: string | null; wait?: boolean; hangup?: boolean }


export async function callStep(call: CallRecord, sc: SimScenario, action: CallAction, attempt: number, siteName: string, ai: AiTraceContext | null): Promise<Step> {
  const node = sc.ivr.nodes[call.ivrPath[call.ivrPath.length - 1]] as Node
  const lang = node.language
  const turns: Turn[] = []
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
    // Type-ahead: each digit acts on the menu it reaches; digits after a hold, a person or a mailbox are dropped.
    let at = node
    step = { turns, heard: node.kind, ended: false, outcome: null }
    for (const digit of action.press.replace(/[^0-9*#]/g, "")) {
      turns.push(await turn("ring", `Pressed ${digit}`, { dtmf: digit }))
      const opt = at.kind === "menu" ? at.options?.find((o) => o.digit === digit) : undefined
      if (!opt) {
        turns.push(await (at.kind === "menu" ? ivrTurn(at, "menu", `${LINE[at.language].invalid} ${at.prompt}`, at.en && `${LINE.en.invalid} ${at.en}`) : turn("system", "(no response to the key press)")))
        step = { turns, heard: at.kind, ended: false, outcome: null }
        break
      }
      at = sc.ivr.nodes[opt.next] as Node
      const next = await enter(call, sc, at, attempt, siteName, ai)
      turns.push(...next.turns)
      step = { ...next, turns }
      if (next.ended || at.kind !== "menu") break
    }
  } else if (action.say !== undefined) {
    turns.push(await turn("ring", action.say, { lang, ...(action.sayEn ? { en: action.sayEn } : {}) }))
    call.transcript.push(...turns)
    if (node.kind === "human") {
      const reply = await personTurn(sc.personas.find((x) => x.id === node.personaId)!, node, siteName, call, ai)
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
    const t = await ivrTurn(node, node.kind, `${LINE[lang].again} ${node.prompt}`, node.en && `${LINE.en.again} ${node.en}`)
    call.transcript.push(t)
    await save(call)
    return { turns: [...turns, t], heard: node.kind, ended: false, outcome: null }
  } else {
    turns.push(await turn("ring", "(waits)"))
    if (node.kind === "hold" && node.next) {
      const next = await enter(call, sc, sc.ivr.nodes[node.next] as Node, attempt, siteName, ai)
      step = { ...next, turns: [...turns, ...next.turns] }
    } else if (node.kind === "menu") {
      turns.push(await ivrTurn(node, "menu"))
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
