import Link from "next/link"
import type { ReactNode } from "react"
import { fmtDateTime } from "@/lib/present/time"
import { Icon } from "./icons"
import { RingoFace } from "./ringo"
import { SkipLink } from "./ui"

export type Section = "queue" | "decide" | "trust" | "board" | "inbox" | "customers" | "drivers" | "sites" | "map"

const GROUPS: { label: string; links: { section: Section; href: string; label: string; icon: string }[] }[] = [
  { label: "Work", links: [
    { section: "queue", href: "/", label: "Needs you", icon: "alert" },
    { section: "decide", href: "/decide", label: "Decide", icon: "work" },
    { section: "board", href: "/board", label: "All orders", icon: "car" },
    { section: "inbox", href: "/inbox", label: "Inbox", icon: "inbox" },
    { section: "trust", href: "/trust", label: "What Ringo may do", icon: "key" },
  ] },
  { label: "People and places", links: [
    { section: "customers", href: "/customers", label: "Customers", icon: "people" },
    { section: "drivers", href: "/drivers", label: "Drivers", icon: "driver" },
    { section: "sites", href: "/sites", label: "Places", icon: "building" },
    { section: "map", href: "/map", label: "Map", icon: "pin" },
  ] },
]

export function AppFrame({ children, section, snapshotAt, board = false }: { children: ReactNode; section?: Section; snapshotAt?: string | null; board?: boolean }) {
  return <div className={`app${board ? " app-board" : ""}`}>
    <SkipLink />
    <aside className="sidebar">
      <Link href="/" className="wordmark" aria-label="Ringo, Bahn control room: home"><RingoFace size={44} />Ringo</Link>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {GROUPS.map((group) => <div className="nav-group" key={group.label}>
          <div className="nav-label">{group.label}</div>
          {group.links.map((link) => <Link key={link.section} href={link.href} prefetch={link.section === "map" ? false : undefined} className={`nav-link${section === link.section ? " active" : ""}`} aria-current={section === link.section ? "page" : undefined}>
            <Icon name={link.icon} size={15} />{link.label}
          </Link>)}
        </div>)}
      </nav>
      <div className="sidebar-foot">{snapshotAt && <>Snapshot {fmtDateTime(snapshotAt)}<br /></>}Fictional data · calls and drivers simulated<br /><Link href="/trust#crew" className="foot-link">Meet the crew</Link></div>
    </aside>
    <div className="main" id="main" tabIndex={-1}>{children}</div>
  </div>
}
