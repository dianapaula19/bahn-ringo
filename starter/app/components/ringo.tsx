import { withBase } from "@/lib/base"

/** The lizard cast (public/*.svg, all 214x240 with the head in the same place). */
export const CAST = {
  ringo: { src: "/ringo.svg", alt: "Ringo" },
  dealer: { src: "/lizard-dealer.svg", alt: "Site" },
  customer: { src: "/lizard-customer.svg", alt: "Customer" },
  driver: { src: "/lizard-driver.svg", alt: "Driver" },
} as const
export type Lizard = keyof typeof CAST

/** A lizard's head and collar, cropped with CSS (.lizard-face). `who` null draws a neutral dot of the
 *  same size (Bahn people and system events), so rows stay aligned. */
export function LizardFace({ who, size = 22 }: { who: Lizard | null; size?: number }) {
  if (!who) return <span className="lizard-face none" style={{ width: size, height: size }} aria-hidden="true" />
  return <span className="lizard-face" style={{ width: size, height: size }}>
    {/* eslint-disable-next-line @next/next/no-img-element -- a static svg needs no optimiser */}
    <img src={withBase(CAST[who].src)} alt={CAST[who].alt} />
  </span>
}

export const RingoFace = ({ size = 26 }: { size?: number }) => <LizardFace who="ringo" size={size} />
