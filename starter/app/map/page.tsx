// Places map: every place in the dataset at city level, which cities have an order that
// needs a person (the queue's own triage), and the cars on the road. Inline SVG, no map
// library, no tiles, no external requests.
import type { Metadata } from "next"
import Link from "next/link"
import { eq } from "drizzle-orm"
import { SNAPSHOT, simNow } from "@/lib/agent/clock"
import { triageAll } from "@/lib/agent/story"
import { db } from "@/lib/db"
import { CITY_XY, COUNTRY_PATHS } from "@/lib/europe-map"
import { label } from "@/lib/present/labels"
import { addresses, relatedRecords } from "@/lib/schema"
import { AppFrame } from "../components/app-frame"
import { CityLink } from "./city-link"

export const dynamic = "force-dynamic"

type Place = { id: string; name: string; kind: string; siteId: string | null; orderId: string | null }
type Need = { orderId: string; reference: string; why: string }
type City = { name: string; country: string; xy: [number, number]; places: Place[]; needs: Need[]; ferries: string[] }

// The part of the base map that holds places (MAP_W x MAP_H is all of Europe).
const VIEW = { x: 170, y: 215, w: 830, h: 1075 }
// Helsinki, Espoo and Vantaa sit within a few km: the main map frames them, the inset spreads them out.
const CAPITAL = new Set(["Helsinki", "Espoo", "Vantaa"])
const INSET = { x: 826, y: 520, w: 170, h: 120, view: { x: 772, y: 460, w: 34, h: 24 } }
const ZOOM = INSET.w / INSET.view.w
const INSET_COUNTRIES = new Set(["FI", "EE", "RU", "AX", "SE"])
// Labels sit right of the dot unless a neighbour is there.
const LABEL_LEFT = new Set(["Turku", "Antwerp", "Rotterdam", "Lille", "Düsseldorf", "Odense", "Gothenburg", "Espoo"])
const LABEL_ABOVE = new Set(["Vantaa"])
const LABEL_BELOW = new Set(["Helsinki"])
const LABEL_BELOW_RIGHT = new Set(["Copenhagen"])
const radius = (n: number) => 3 + 2.6 * Math.sqrt(n)
const countryName = new Intl.DisplayNames(["en"], { type: "region" })

async function loadMap() {
  const now = await simNow()
  const [rows, terminals, triaged] = await Promise.all([
    db.select({ id: addresses.id, name: addresses.name, city: addresses.city, country: addresses.country, siteId: addresses.managedSiteId, orderId: addresses.orderId, details: addresses.details }).from(addresses),
    db.select({ details: relatedRecords.details }).from(relatedRecords).where(eq(relatedRecords.collection, "ferry_terminals")),
    triageAll(now),
  ])
  const cities = new Map<string, City>()
  const city = (name: string | undefined, country = ""): City | null => {
    if (!name || !CITY_XY[name]) return null
    if (!cities.has(name)) cities.set(name, { name, country, xy: CITY_XY[name], places: [], needs: [], ferries: [] })
    return cities.get(name)!
  }
  for (const r of rows) city(r.city, r.country)?.places.push({ id: r.id, name: r.name, kind: String(r.details.kind ?? "OTHER"), siteId: r.siteId, orderId: r.orderId })
  for (const t of terminals) city(String(t.details.city), String(t.details.country))?.ferries.push(String(t.details.name))

  const refs = new Map<string, string>()
  const road: [[number, number], [number, number]][] = []
  for (const { bundle: b, triage: t } of triaged) {
    refs.set(b.order.id, b.order.reference)
    const ends = [...new Set([b.places.get(b.order.pickupAddressId)?.city, b.places.get(b.order.deliveryAddressId)?.city])]
    if (t.bucket === "needs_you") for (const c of ends) city(c)?.needs.push({ orderId: b.order.id, reference: b.order.reference, why: t.why })
    const [from, to] = [b.places.get(b.order.pickupAddressId)?.city, b.places.get(b.order.deliveryAddressId)?.city]
    if (b.order.status === "IN_TRANSIT" && from && to && from !== to && CITY_XY[from] && CITY_XY[to]) road.push([CITY_XY[from], CITY_XY[to]])
  }
  const list = [...cities.values()].filter((c) => c.places.length || c.ferries.length).sort((a, b) => b.places.length - a.places.length || a.name.localeCompare(b.name))
  const needsYou = triaged.filter((x) => x.triage.bucket === "needs_you").length
  return { cities: list, road, refs, needsYou, placeCount: rows.length, countries: new Set(rows.map((r) => r.country)) }
}

type Props = { searchParams: Promise<{ city?: string | string[] }> }

/** ?city= matched to a known city, ignoring case, accents and stray spaces. */
const askedCity = async (searchParams: Props["searchParams"]) => {
  const c = (await searchParams).city
  return typeof c === "string" && c.trim() ? c.trim() : null
}
const sameCity = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" }) === 0

// The title names a matched city only, never the raw query text.
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const asked = await askedCity(searchParams)
  const name = asked && Object.keys(CITY_XY).find((n) => sameCity(n, asked))
  return { title: name ? `${name} · Map` : "Map" }
}

export default async function MapPage({ searchParams }: Props) {
  const selectedName = await askedCity(searchParams)
  const m = await loadMap()
  const selected = selectedName ? m.cities.find((c) => sameCity(c.name, selectedName)) ?? null : null
  const flagged = m.cities.filter((c) => c.needs.length)
  const summary = `Map of ${m.cities.length} cities with ${m.placeCount} places. ${flagged.length} cities have an order that needs you${flagged.length ? `: ${flagged.map((c) => c.name).join(", ")}` : ""}. ${m.road.length} cars on the road between cities.`

  return <AppFrame section="map" snapshotAt={SNAPSHOT}><main className="page map-page">
    <h1 className="page-title small">Map</h1>
    <p className="intro">Where our places are, which cities have an order that needs you, and where cars are on the road.</p>
    <div className="map-layout">
      <figure className="map-figure">
        <svg className={`map-svg${selected ? " has-selected" : ""}`} viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`} aria-label="Places map">
          <g role="img" aria-label={summary}>
            <Countries filter={null} withPlaces={m.countries} stroke={0.8} />
            {m.road.map(([a, b], i) => <path key={i} className="map-road" d={arc(a, b)} strokeWidth={1.3} />)}
            {m.cities.filter((c) => CAPITAL.has(c.name)).map((c) => <Dot key={c.name} c={c} scale={1} selected={false} />)}
            <rect className="map-frame" x={INSET.view.x + 2} y={INSET.view.y + 2} width={INSET.view.w - 4} height={INSET.view.h - 4} rx={3} />
            <path className="map-leader" d={`M${INSET.view.x + INSET.view.w - 2} ${INSET.view.y + INSET.view.h / 2} L${INSET.x} ${INSET.y + INSET.h / 2}`} />
          </g>
          <HitLayer cities={m.cities.filter((c) => !CAPITAL.has(c.name))} scale={1} />
          {m.cities.filter((c) => !CAPITAL.has(c.name)).sort((a, b) => Number(a === selected) - Number(b === selected)).map((c) => <City key={c.name} c={c} scale={1} selected={c === selected} />)}
          <svg x={INSET.x} y={INSET.y} width={INSET.w} height={INSET.h} viewBox={`${INSET.view.x} ${INSET.view.y} ${INSET.view.w} ${INSET.view.h}`}>
            <rect className="map-sea" x={INSET.view.x} y={INSET.view.y} width={INSET.view.w} height={INSET.view.h} />
            <Countries filter={INSET_COUNTRIES} withPlaces={m.countries} stroke={0.8 / ZOOM} />
            <HitLayer cities={m.cities.filter((c) => CAPITAL.has(c.name))} scale={1 / ZOOM} />
            {m.cities.filter((c) => CAPITAL.has(c.name)).map((c) => <City key={c.name} c={c} scale={1 / ZOOM} selected={c === selected} />)}
          </svg>
          <rect className="map-inset-edge" x={INSET.x} y={INSET.y} width={INSET.w} height={INSET.h} rx={4} />
          <text className="map-inset-label" x={INSET.x + 6} y={INSET.y + INSET.h + 15}>Helsinki region</text>
        </svg>
        <figcaption>
          <ul className="map-legend">
            <li><svg viewBox="-8 -8 16 16" aria-hidden="true"><circle className="map-dot" r="6" strokeWidth="1" /></svg>Places in a city (bigger is more)</li>
            <li><svg viewBox="-8 -8 16 16" aria-hidden="true"><circle className="map-dot" r="4" strokeWidth="1" /><circle className="map-needs" r="6.5" strokeWidth="1.8" /></svg>An order here needs you</li>
            <li><svg viewBox="0 -8 22 16" aria-hidden="true"><path className="map-road solo" d="M1 4 Q11 -6 21 4" strokeWidth="2" /></svg>Car on the road, pickup to delivery city</li>
            <li><svg viewBox="-8 -8 16 16" aria-hidden="true"><rect className="map-ferry" x="-4" y="-4" width="8" height="8" strokeWidth="1.2" /></svg>Ferry terminal</li>
          </ul>
          <p>Places shown at city level. Addresses in this dataset are fictional.</p>
        </figcaption>
      </figure>
      <aside className="map-panel" id="city" aria-live="polite">
        {selected ? <CityPanel c={selected} refs={m.refs} />
          : <>
            {selectedName && <p className="empty">No places in “{selectedName}”. Pick a city below.</p>}
            <h2>Cities</h2>
            <p className="map-panel-sub">{m.placeCount} places in {m.cities.length} cities · {m.needsYou} orders need you</p>
            <ul className="map-cities">{m.cities.map((c) => <li key={c.name}>
              <CityLink city={c.name} from="list">{c.name}</CityLink>
              {c.needs.length > 0 && <span className="map-flag">{c.needs.length} need{c.needs.length === 1 ? "s" : ""} you</span>}
              <span className="num">{c.places.length}</span>
            </li>)}</ul>
          </>}
      </aside>
    </div>
  </main></AppFrame>
}

function CityPanel({ c, refs }: { c: City; refs: Map<string, string> }) {
  const kinds = new Map<string, Place[]>()
  for (const p of c.places) kinds.set(p.kind, [...(kinds.get(p.kind) ?? []), p])
  return <>
    <p className="map-back"><Link href="/map">All cities</Link></p>
    <h2>{c.name}</h2>
    <p className="map-panel-sub">{countryName.of(c.country) ?? c.country} · {c.places.length} place{c.places.length === 1 ? "" : "s"}</p>
    <h3>Needs you here</h3>
    {c.needs.length
      ? <ul className="map-needs-list">{c.needs.map((n) => <li key={n.orderId}><Link href={`/orders/${n.orderId}`}><span className="mono">{n.reference}</span>{n.why}</Link></li>)}</ul>
      : <p className="empty">No order here needs a person.</p>}
    {c.ferries.map((f) => <p key={f} className="map-ferry-line"><svg viewBox="-6 -6 12 12" aria-hidden="true"><rect className="map-ferry" x="-4" y="-4" width="8" height="8" strokeWidth="1.2" /></svg>Ferry terminal: {f}</p>)}
    <h3>Places</h3>
    {[...kinds].sort((a, b) => b[1].length - a[1].length).map(([kind, ps]) => <div key={kind} className="map-kind">
      <h4>{label(kind)} <span className="num">{ps.length}</span></h4>
      <ul>{ps.map((p) => <li key={p.id}>{p.siteId ? <Link href={`/sites/${p.siteId}`}>{p.name}</Link>
        : p.orderId ? <>{p.name}, for <Link className="mono" href={`/orders/${p.orderId}`}>{refs.get(p.orderId) ?? p.orderId}</Link></> : p.name}</li>)}</ul>
    </div>)}
  </>
}

function Countries({ filter, withPlaces, stroke }: { filter: Set<string> | null; withPlaces: Set<string>; stroke: number }) {
  return <g strokeWidth={stroke}>{COUNTRY_PATHS.filter((p) => !filter || filter.has(p.iso)).map((p, i) =>
    <path key={`${p.iso}-${i}`} d={p.d} className={withPlaces.has(p.iso) ? "map-land has-places" : "map-land"} />)}</g>
}

/** A gentle arc so A→B and B→A do not sit on top of each other. */
function arc([x1, y1]: [number, number], [x2, y2]: [number, number]) {
  const [mx, my, dx, dy] = [(x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1]
  return `M${x1} ${y1} Q${mx - dy * 0.15} ${my + dx * 0.15} ${x2} ${y2}`
}

function Dot({ c, scale, selected }: { c: City; scale: number; selected: boolean }) {
  const [x, y] = c.xy
  const r = radius(c.places.length) * scale
  return <>
    {selected && <circle className="map-halo" cx={x} cy={y} r={r + 9 * scale} strokeWidth={2 * scale} />}
    {c.needs.length > 0 && <circle className="map-needs" cx={x} cy={y} r={r + 3.5 * scale} strokeWidth={2.2 * scale} />}
    <circle className={`map-dot${selected ? " selected" : ""}`} cx={x} cy={y} r={r} strokeWidth={(selected ? 2.5 : 1) * scale} />
    {c.ferries.length > 0 && <rect className="map-ferry" x={x + r * 0.7} y={y - r * 0.7 - 8 * scale} width={8 * scale} height={8 * scale} strokeWidth={1.2 * scale} />}
  </>
}

// Invisible tap targets about 44 px across on a 390 px phone (~0.43 px per map unit there). They sit under
// every dot, so tapping a dot always opens that city; where two overlap, the later city wins.
const HIT_R = 51
function HitLayer({ cities, scale }: { cities: City[]; scale: number }) {
  return <g aria-hidden="true">{cities.map((c) => <CityLink key={c.name} city={c.name} from="map" hidden>
    <circle className="map-hit" cx={c.xy[0]} cy={c.xy[1]} r={HIT_R * scale} /></CityLink>)}</g>
}

function City({ c, scale, selected }: { c: City; scale: number; selected: boolean }) {
  const [x, y] = c.xy
  const r = radius(c.places.length) * scale
  const labelled = c.places.length >= 3 || c.needs.length > 0 || selected
  const left = LABEL_LEFT.has(c.name), above = LABEL_ABOVE.has(c.name), below = LABEL_BELOW.has(c.name), belowRight = LABEL_BELOW_RIGHT.has(c.name)
  const lx = above || below ? x : belowRight ? x - 2 * scale : left ? x - r - 5 * scale : x + r + 5 * scale
  const ly = above ? y - r - 6 * scale : below || belowRight ? y + r + 15 * scale : y + 5 * scale
  const desc = `${c.name}: ${c.places.length} place${c.places.length === 1 ? "" : "s"}${c.needs.length ? `, ${c.needs.length} order${c.needs.length === 1 ? "" : "s"} need${c.needs.length === 1 ? "s" : ""} you` : ""}${c.ferries.length ? ", ferry terminal" : ""}`
  return <CityLink city={c.name} from="map" label={desc} className={`map-city${selected ? " is-selected" : ""}`}>
    <title>{desc}</title>
    <circle className="map-hit" cx={x} cy={y} r={Math.max(r + 5 * scale, 13 * scale)} strokeWidth={1.5 * scale} />
    <Dot c={c} scale={scale} selected={selected} />
    {labelled && <text className={`map-label${c.needs.length ? " needs" : ""}${selected ? " selected" : ""}`} x={lx} y={ly} fontSize={15 * scale} strokeWidth={3.5 * scale} textAnchor={above || below ? "middle" : left ? "end" : "start"}>{c.name}</text>}
  </CityLink>
}
