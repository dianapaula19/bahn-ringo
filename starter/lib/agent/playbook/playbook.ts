// Site playbooks: short notes per site that make the next call faster. Code writes
// what it observed on the line (the menu path that reached a person, a dropped
// transfer); Ringo writes what the site said, each with the site's own words.
// Every note cites the Ringo call and the moment it came from.
import { and, asc, eq, isNull, ne } from "drizzle-orm"
import { db } from "@/lib/db"
import type { CallRecord } from "@/lib/contract"
import { orders } from "@/lib/schema"
import { ringPlaybooks } from "@/lib/ring-schema"
import { newId, simNow } from "../clock"
import { callLang, callRung, pathOf, pathText, PLAYBOOK_TOPICS, RUNG_LABEL, type PlaybookEntry, type PlaybookTopic, type Turn } from "../sim/calls"

type Row = typeof ringPlaybooks.$inferSelect
const iso = (v: string | null) => (v ? new Date(v).toISOString() : null)
const toEntry = (r: Row, refs: Map<string, string>): PlaybookEntry => ({
  id: r.id, siteId: r.siteId, topic: r.topic as PlaybookTopic, rung: (r.rung as PlaybookEntry["rung"]) ?? null, note: r.note, quote: r.quote,
  language: (r.language as PlaybookEntry["language"]) ?? null, level: r.level as PlaybookEntry["level"], sourceCallId: r.sourceCallId, orderId: r.orderId,
  orderRef: refs.get(r.orderId) ?? null, sourceAt: iso(r.sourceAt)!, createdAt: iso(r.createdAt)!, editedBy: r.editedBy, editedAt: iso(r.editedAt),
})
const rank = (t: string) => PLAYBOOK_TOPICS.findIndex((x) => x.id === t)

export async function readPlaybook(siteId: string): Promise<PlaybookEntry[]> {
  const rows = await db.select().from(ringPlaybooks).where(eq(ringPlaybooks.siteId, siteId)).orderBy(asc(ringPlaybooks.sourceAt))
  const refs = new Map((await db.select({ id: orders.id, reference: orders.reference }).from(orders)).map((o) => [o.id, o.reference]))
  return rows.map((r) => toEntry(r, refs)).sort((a, b) => rank(a.topic) - rank(b.topic) || b.sourceAt.localeCompare(a.sourceAt))
}

/** Insert notes from one call. A newer call replaces the older, unedited notes on the same topic and rung; a person's edit is never overwritten. */
async function put(call: CallRecord, notes: { topic: PlaybookTopic; note: string; quote: string | null; level: "quoted" | "observed"; at: string }[]) {
  const rung = callRung(call.transcript)
  const lang = callLang(call.transcript)
  const createdAt = await simNow()
  for (const topic of new Set(notes.map((n) => n.topic))) {
    await db.delete(ringPlaybooks).where(and(eq(ringPlaybooks.siteId, call.siteId), eq(ringPlaybooks.topic, topic), rung ? eq(ringPlaybooks.rung, rung) : isNull(ringPlaybooks.rung),
      ne(ringPlaybooks.sourceCallId, call.id), isNull(ringPlaybooks.editedBy)))
  }
  const rows = notes.map((n) => ({ id: newId("pb"), siteId: call.siteId, topic: n.topic, rung, note: n.note, quote: n.quote, language: n.quote ? lang : null,
    level: n.level, sourceCallId: call.id, orderId: call.orderId, sourceAt: n.at, createdAt }))
  if (rows.length) await db.insert(ringPlaybooks).values(rows)
  return rows.length
}

/** After a call ends, code writes what it observed: the path that reached a person, or where the line dropped. */
export async function observeCall(call: CallRecord): Promise<number> {
  const path = pathOf(call.transcript)
  const rung = callRung(call.transcript)
  const person = (call.transcript as Turn[]).find((t) => t.speaker === "site")
  if (call.outcome === "ANSWERED" && person) {
    return put(call, [{ topic: "phone_path", level: "observed", quote: null, at: person.at, note: `${rung ? `${RUNG_LABEL[rung]}: ` : ""}${pathText(path)}.` }])
  }
  if (call.outcome === "DROPPED_UNKNOWN") {
    const at = call.endedAt ?? call.startedAt
    return put(call, [{ topic: "quirk", level: "observed", quote: null, at, note: `The line dropped here once: ${pathText(path)}. Nobody confirmed anything; reconcile before redialling.` }])
  }
  return 0
}

/** Ringo's notes from what the site said (already checked against the transcript by the tool). */
export const noteFromCall = (call: CallRecord, notes: { topic: PlaybookTopic; note: string; quote: string; at: string }[]) =>
  put(call, notes.map((n) => ({ ...n, level: "quoted" as const })))

export async function editNote(id: string, note: string, by: string): Promise<PlaybookEntry | null> {
  const [row] = await db.update(ringPlaybooks).set({ note, editedBy: by, editedAt: await simNow() }).where(eq(ringPlaybooks.id, id)).returning()
  return row ? (await readPlaybook(row.siteId)).find((e) => e.id === id) ?? null : null
}

export async function deleteNote(id: string): Promise<boolean> {
  return (await db.delete(ringPlaybooks).where(eq(ringPlaybooks.id, id)).returning()).length > 0
}
