import { withBase } from "@/lib/base"

/** The lizard cast (public/*.svg, all 214x240 with the head in the same place). */
export const CAST = {
  ringo: { src: "/ringo.svg", alt: "Ringo", role: "Rings the sites" },
  dealer: { src: "/lizard-dealer.svg", alt: "Site", role: "Hands the car over" },
  customer: { src: "/lizard-customer.svg", alt: "Customer", role: "Pays for the move" },
  driver: { src: "/lizard-driver.svg", alt: "Driver", role: "Drives it there" },
} as const
export type Lizard = keyof typeof CAST

/** "Support desk" → "SD", "System" → "S". */
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("")

/** A lizard's head in a circle with a role-coloured ring (.lizard-face). `who` null is a person or system
 *  inside Bahn: a muted monogram of the same size, so rows stay aligned. */
export function LizardFace({ who, size = 28, name }: { who: Lizard | null; size?: number; name?: string }) {
  if (!who) return <span className="lizard-face mono-face" style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }} aria-hidden="true">{name ? initials(name) : ""}</span>
  return <span className={`lizard-face w-${who}`} style={{ width: size, height: size }}>
    {/* eslint-disable-next-line @next/next/no-img-element -- a static svg needs no optimiser */}
    <img src={withBase(CAST[who].src)} alt={CAST[who].alt} />
  </span>
}

/** Who a source line came from, as one word in the role's colour (.role-tag). Faces stay in the crew strip:
 *  at 24 px the green lizards read alike, a word does not. `null` is someone inside Bahn. */
export type Role = Lizard | "ops" | "system"
const ROLE_WORD: Record<Role, string> = { ringo: "Ringo", dealer: "Site", customer: "Customer", driver: "Driver", ops: "Ops", system: "System" }
export function RoleTag({ role }: { role: Role | null }) {
  const r = role ?? "ops"
  return <span className={`role-tag r-${r}`}>{ROLE_WORD[r]}</span>
}

export const RingoFace = ({ size = 28 }: { size?: number }) => <LizardFace who="ringo" size={size} />

/** The whole cast standing in a row, full figure, with who they are. Decorative where the text says it. */
export function CastLineup({ height = 96, captions = true }: { height?: number; captions?: boolean }) {
  return <ul className="cast-lineup" aria-label={captions ? "The cast" : undefined} aria-hidden={captions ? undefined : true}>
    {(Object.keys(CAST) as Lizard[]).map((w) => <li key={w}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a static svg needs no optimiser */}
      <img src={withBase(CAST[w].src)} alt="" width={Math.round(height * 214 / 240)} height={height} />
      {captions && <span><b>{w === "ringo" ? "Ringo" : CAST[w].alt}</b>{CAST[w].role}</span>}
    </li>)}
  </ul>
}
