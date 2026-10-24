// "Since you left": the Scribe writes a few sentences from what happened since
// `since`. Every sentence cites source ids; the validator drops any sentence
// whose ids do not all resolve, and counts it. Without a key, a template
// writes one sentence per item.
import { gte } from "drizzle-orm"
import type Anthropic from "@anthropic-ai/sdk"
import { db } from "@/lib/db"
import type { Handover, HandoverSentence, SourceRef } from "@/lib/contract"
import { humanize } from "@/lib/present/labels"
import { messages, operationalEvents, orders } from "@/lib/schema"
import { ringCalls, ringEvents, ringProposals, ringRuns } from "@/lib/ring-schema"
import { SNAPSHOT, simNow } from "./clock"
import { resolveSources } from "./facts"
import { anthropic, BETAS, MODEL } from "./llm"

type Item = { id: string; table: string; at: string; orderId: string; text: string }
const iso = (v: Date | string) => new Date(v).toISOString()
const hhmm = (v: string) => `${v.slice(11, 16)} UTC`

async function items(since: string): Promise<Item[]> {
  const s = new Date(since)
  const [evs, msgs, revs, runs, calls, props, ords] = await Promise.all([
    db.select().from(operationalEvents).where(gte(operationalEvents.recordedAt, s)),
    db.select().from(messages).where(gte(messages.authoredAt, s)),
    db.select().from(ringEvents).where(gte(ringEvents.at, since)),
    db.select().from(ringRuns).where(gte(ringRuns.startedAt, since)),
    db.select().from(ringCalls).where(gte(ringCalls.startedAt, since)),
    db.select().from(ringProposals),
    db.select({ id: orders.id, reference: orders.reference }).from(orders),
  ])
  const ref = new Map(ords.map((o) => [o.id, o.reference]))
  const R = (id: string) => ref.get(id) ?? id
  const out: Item[] = [
    ...evs.map((e) => ({ id: e.id, table: "operational_events", at: iso(e.recordedAt), orderId: e.orderId, text: `${R(e.orderId)}: ${humanize(e.command)}${e.details.actor_type ? ` by ${e.details.actor_id ?? e.details.actor_type}` : ""}` })),
    ...msgs.filter((m) => m.details.visibility !== "INTERNAL").map((m) => ({ id: m.id, table: "messages", at: iso(m.authoredAt), orderId: m.orderId, text: `${R(m.orderId)}: ${m.authorType} via ${String(m.details.channel ?? "").replace(/_/g, " ")}: "${m.body.slice(0, 220)}"` })),
    ...revs.map((e) => ({ id: e.id, table: "ring_events", at: iso(e.at), orderId: e.orderId, text: `${R(e.orderId)}: ${humanize(e.command)} committed by ${e.actorId} (simulated)` })),
    ...runs.filter((r) => r.decision).map((r) => ({ id: r.id, table: "ring_runs", at: iso(r.endedAt ?? r.startedAt), orderId: r.orderId, text: `${R(r.orderId)}: Ring stopped (${(r.decision as { outcome: string }).outcome}): ${(r.decision as { headline: string }).headline}` })),
    ...calls.filter((c) => c.outcome).map((c) => ({ id: c.id, table: "ring_calls", at: iso(c.startedAt), orderId: c.orderId, text: `${R(c.orderId)}: Ring called ${c.siteId} (simulated), outcome ${String(c.outcome).toLowerCase().replace(/_/g, " ")}` })),
    ...props.filter((p) => p.review && (p.review as { reviewedAt: string }).reviewedAt >= since).map((p) => {
      const r = p.review as { decision: string; reviewerId: string; reviewedAt: string; decisionNote: string | null }
      return { id: p.id, table: "ring_proposals", at: r.reviewedAt, orderId: p.orderId, text: `${R(p.orderId)}: ${r.reviewerId} ${r.decision.toLowerCase()} Ring's proposal "${p.summary}"${r.decisionNote ? ` (${r.decisionNote})` : ""}` }
    }),
  ]
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

const SCRIBE = `You write the "Since you left" handover for a shift lead in a car delivery control room. From the numbered items, write at most 7 short sentences, most important first: decisions waiting, safety, blocks, and what Ring found or did. Plain words. Name orders by their CD- reference, never by row ids; times as HH:MM UTC. Each sentence must list the ids of the items it is based on in sourceIds (copy them exactly). Do not state anything the items do not say. Simulated calls are simulated: say so.`

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["sentences"],
  properties: { sentences: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "sourceIds", "orderId"],
    properties: { text: { type: "string" }, sourceIds: { type: "array", items: { type: "string" } }, orderId: { type: ["string", "null"] } } } } },
}

async function scribe(list: Item[]): Promise<{ text: string; sourceIds: string[]; orderId: string | null }[] | null> {
  const c = anthropic()
  if (!c || !list.length) return null
  try {
    const msg = await c.beta.messages.create({
      model: MODEL, max_tokens: 4000, betas: BETAS, fallbacks: "default", thinking: { type: "adaptive" },
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } }, system: SCRIBE,
      messages: [{ role: "user", content: list.map((i) => `[${i.id}] ${hhmm(i.at)} order ${i.orderId}: ${i.text}`).join("\n") }],
    } as Anthropic.Beta.MessageCreateParamsNonStreaming)
    if (msg.stop_reason === "refusal") return null
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
    return (JSON.parse(text) as { sentences: { text: string; sourceIds: string[]; orderId: string | null }[] }).sentences
  } catch {
    return null
  }
}

/** Keep a sentence only if it has ids and every id resolves. */
export async function validate(drafts: { text: string; sourceIds: string[]; orderId: string | null }[]): Promise<{ sentences: HandoverSentence[]; dropped: number }> {
  const found = await resolveSources(drafts.flatMap((d) => d.sourceIds))
  const sentences: HandoverSentence[] = []
  for (const d of drafts) {
    if (!d.text.trim() || !d.sourceIds.length || !d.sourceIds.every((id) => found.has(id))) continue
    sentences.push({ text: d.text.trim(), orderId: d.orderId, sourceIds: d.sourceIds.map((id): SourceRef => ({ table: found.get(id)!.table, id })) })
  }
  return { sentences, dropped: drafts.length - sentences.length }
}

const cache = new Map<string, Handover>()
const writing = new Map<string, Promise<void>>()

export async function handover(sinceArg: string | null, wait = false): Promise<Handover> {
  const now = await simNow()
  const since = sinceArg && !Number.isNaN(Date.parse(sinceArg)) ? new Date(sinceArg).toISOString() : new Date(Date.parse(SNAPSHOT) - 3 * 3600_000).toISOString()
  const list = (await items(since)).filter((i) => i.at <= now).slice(-40)
  const key = `${since}|${list.length}|${list[list.length - 1]?.id ?? ""}`
  const hit = cache.get(key)
  if (hit) return { ...hit, now }
  // The Scribe takes seconds; never hold the page on it. Answer with the template now and let the
  // Scribe fill the cache for the next load (the strip asks once more when it got the template).
  if (!writing.has(key)) writing.set(key, scribe(list).then(async (drafted) => {
    if (drafted) cache.set(key, { now, since, ...(await validate(drafted)), writer: "scribe" })
  }).catch(() => {}))
  if (wait) { await writing.get(key); const done = cache.get(key); if (done) return { ...done, now } }
  const drafts = list.slice(-12).reverse().map((i) => ({ text: `${hhmm(i.at)}: ${i.text}`, sourceIds: [i.id], orderId: i.orderId }))
  return { now, since, ...(await validate(drafts)), writer: "template" }
}

export const handoverText = (h: Handover) =>
  [`Since ${hhmm(h.since)} (${h.sentences.length} items${h.dropped ? `, ${h.dropped} dropped for missing sources` : ""})`,
    ...h.sentences.map((s) => `- ${s.text} [${s.sourceIds.map((r) => r.id).join(", ")}]`)].join("\n")
