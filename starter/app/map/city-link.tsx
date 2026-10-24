"use client"

import Link from "next/link"
import posthog from "posthog-js"
import type { ReactNode } from "react"

/** A link that opens one city's panel (?city=Name). A plain link without JS; PostHog sees the click when it is set up. */
export function CityLink({ city, from, label, className, hidden, children }: { city: string; from: "map" | "list"; label?: string; className?: string; hidden?: boolean; children: ReactNode }) {
  return <Link href={`/map?city=${encodeURIComponent(city)}#city`} aria-label={label} className={className} prefetch={false} tabIndex={hidden ? -1 : undefined}
    onClick={() => posthog.capture("map_city_opened", { city, from })}>{children}</Link>
}
