// Scale test data: clone the 100 dataset orders (and every row that belongs to
// them) into 9 synthetic copies, giving 1,000 orders. Deterministic: copy k of
// an id is `<id>-s<k>`, of a reference `<ref>-S<k>`, and every cloned row carries
// `details.synthetic_scale = { copy, of }`. Times are unchanged, so each copy has
// the same trouble as the original: a worst case, not a realistic mix.
// Shared rows (customers, sites, drivers, site addresses, operators) are reused.
// The dataset, the seed script and the starter schema are untouched.
//
//   npx tsx scripts/scale-seed.ts          # (re)build copies 1..9
//   npx tsx scripts/scale-seed.ts --undo   # remove every synthetic copy
//   SCALE_COPIES=4 npx tsx scripts/scale-seed.ts
// Refuses to run against a database named "controlroom" (the shared one).
import "dotenv/config"
import { like, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "../lib/schema"

const url = process.env.DATABASE_URL
if (!url) throw new Error("Set DATABASE_URL")
const dbName = new URL(url).pathname.slice(1)
if (dbName === "controlroom") throw new Error("scale-seed writes 900 synthetic orders; point DATABASE_URL at a scratch database, not controlroom")

const client = postgres(url, { max: 1 })
const db = drizzle(client, { schema })
const COPIES = Number(process.env.SCALE_COPIES ?? 9)
const SYN = "%-s_" // every synthetic id ends in -s<k> (k = 1..9)

type Json = Record<string, unknown>

/** Replace every order-scoped id (and reference) inside a value with copy k's. */
function makeMapper(ids: Set<string>, refs: Set<string>, k: number) {
  const all = [...ids, ...refs].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const re = new RegExp(`(?<![A-Za-z0-9-])(${all.join("|")})(?![A-Za-z0-9-])`, "g")
  const one = (s: string) => s.replace(re, (m) => (refs.has(m) ? `${m}-S${k}` : `${m}-s${k}`))
  return {
    id: (s: string) => (ids.has(s) ? `${s}-s${k}` : s),
    opt: (s: string | null) => (s && ids.has(s) ? `${s}-s${k}` : s),
    text: one,
    json: (v: Json, of: string): Json => ({ ...(JSON.parse(one(JSON.stringify(v))) as Json), synthetic_scale: { copy: k, of } }),
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function undo(tx: Tx) {
  // Children first: the starter's tables have foreign keys to orders/vehicles/addresses.
  await tx.delete(schema.relatedRecords).where(like(schema.relatedRecords.id, SYN))
  await tx.delete(schema.operationalEvents).where(like(schema.operationalEvents.id, SYN))
  await tx.delete(schema.alerts).where(like(schema.alerts.id, SYN))
  await tx.delete(schema.messages).where(like(schema.messages.id, SYN))
  await tx.delete(schema.conversations).where(like(schema.conversations.id, SYN))
  await tx.delete(schema.orderItems).where(like(schema.orderItems.id, SYN))
  await tx.delete(schema.orders).where(like(schema.orders.id, SYN))
  await tx.delete(schema.vehicles).where(like(schema.vehicles.id, SYN))
  await tx.delete(schema.addresses).where(like(schema.addresses.id, SYN))
}

const notSyn = <T extends { id: string }>(rows: T[]) => rows.filter((r) => !/-s\d$/.test(r.id))
const batches = async <T>(rows: T[], insert: (b: T[]) => Promise<unknown>) => {
  for (let i = 0; i < rows.length; i += 500) await insert(rows.slice(i, i + 500))
}

async function main() {
  await db.transaction(async (tx) => {
    await undo(tx)
    if (process.argv.includes("--undo")) return
    const [orders, items, vehicles, addresses, convs, msgs, alerts, events, related] = await Promise.all([
      tx.select().from(schema.orders).then(notSyn), tx.select().from(schema.orderItems).then(notSyn),
      tx.select().from(schema.vehicles).then(notSyn), tx.select().from(schema.addresses).then(notSyn),
      tx.select().from(schema.conversations).then(notSyn), tx.select().from(schema.messages).then(notSyn),
      tx.select().from(schema.alerts).then(notSyn), tx.select().from(schema.operationalEvents).then(notSyn),
      tx.select().from(schema.relatedRecords).where(sql`${schema.relatedRecords.orderId} is not null`).then(notSyn),
    ])
    const orderAddrs = addresses.filter((a) => a.orderId)
    const itemVehicles = new Set(items.map((i) => i.vehicleId))
    const ownVehicles = vehicles.filter((v) => itemVehicles.has(v.id))
    // Order-scoped ids: everything that hangs off an order. Shared rows keep their ids.
    const ids = new Set<string>([
      ...orders, ...items, ...ownVehicles, ...orderAddrs, ...convs, ...msgs, ...alerts, ...events, ...related,
    ].map((r) => r.id))
    const refs = new Set(orders.map((o) => o.reference))

    for (let k = 1; k <= COPIES; k++) {
      const m = makeMapper(ids, refs, k)
      await batches(ownVehicles.map((v) => ({ ...v, id: m.id(v.id) })), (b) => tx.insert(schema.vehicles).values(b))
      await batches(orderAddrs.map((a) => ({ ...a, id: m.id(a.id), orderId: m.opt(a.orderId), name: m.text(a.name), details: m.json(a.details, a.id) })),
        (b) => tx.insert(schema.addresses).values(b))
      await batches(orders.map((o) => ({
        ...o, id: m.id(o.id), reference: `${o.reference}-S${k}`, pickupAddressId: m.id(o.pickupAddressId), deliveryAddressId: m.id(o.deliveryAddressId),
        details: m.json(o.details, o.id),
      })), (b) => tx.insert(schema.orders).values(b))
      await batches(items.map((i) => ({ ...i, id: m.id(i.id), orderId: m.id(i.orderId), vehicleId: m.id(i.vehicleId), details: m.json(i.details, i.id) })),
        (b) => tx.insert(schema.orderItems).values(b))
      await batches(convs.map((c) => ({ ...c, id: m.id(c.id), orderId: m.id(c.orderId), details: m.json(c.details, c.id) })),
        (b) => tx.insert(schema.conversations).values(b))
      await batches(msgs.map((x) => ({ ...x, id: m.id(x.id), orderId: m.id(x.orderId), conversationId: m.id(x.conversationId), body: m.text(x.body), details: m.json(x.details, x.id) })),
        (b) => tx.insert(schema.messages).values(b))
      await batches(alerts.map((a) => ({ ...a, id: m.id(a.id), orderId: m.id(a.orderId), summary: m.text(a.summary), details: m.json(a.details, a.id) })),
        (b) => tx.insert(schema.alerts).values(b))
      await batches(events.map((e) => ({ ...e, id: m.id(e.id), orderId: m.id(e.orderId), targetId: m.id(e.targetId), details: m.json(e.details, e.id) })),
        (b) => tx.insert(schema.operationalEvents).values(b))
      await batches(related.map((r) => ({ ...r, id: m.id(r.id), orderId: m.opt(r.orderId), details: m.json(r.details, r.id) })),
        (b) => tx.insert(schema.relatedRecords).values(b))
    }
  })
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.orders)
  console.log(process.argv.includes("--undo") ? `Removed synthetic copies; ${n} orders left.` : `${n} orders (${COPIES} synthetic copies of each dataset order).`)
}

main().finally(() => client.end())
