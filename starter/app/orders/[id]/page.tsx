"use client"

import Link from "next/link"
import { use, useCallback, useEffect, useMemo, useState } from "react"
import type { OrderStory } from "@/lib/contract"
import { loadStory } from "../../_lib/agent-api"
import { AppFrame } from "../../components/app-frame"
import { Icon } from "../../components/icons"
import type { Detail } from "../../components/order-detail"
import { When } from "../../components/ring/bits"
import { RunPanel } from "../../components/ring/run-panel"
import { DecisionPanel, FactsPanel, Timeline, type HeroContext } from "../../components/ring/story"
import { withBase } from "@/lib/base"

// The order API also returns the assigned drivers; RecordView does not carry them.
type OrderDetail = Detail & { drivers?: { id: string; displayName: string }[] }

export default function OrderStoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [story, setStory] = useState<OrderStory | null>(null)
  const [detail, setDetail] = useState<OrderDetail | null>(null)
  const [error, setError] = useState("")

  const refresh = useCallback((signal?: AbortSignal) => loadStory(id, signal)
    .then((data) => { setStory(data); setError("") })
    .catch((e: unknown) => { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Could not load order") }), [id])

  useEffect(() => {
    const c = new AbortController()
    refresh(c.signal)
    fetch(withBase(`/api/orders/${encodeURIComponent(id)}`), { signal: c.signal }).then((r) => (r.ok ? r.json() as Promise<OrderDetail> : null)).then(setDetail).catch(() => {})
    return () => c.abort()
  }, [id, refresh])

  const h = detail?.view.header
  const reference = story?.reference ?? h?.reference ?? null
  useEffect(() => { if (reference) document.title = `${reference} · ${h?.vehicle?.title ?? "Order"} · Ringo` }, [reference, h])
  const ctx = useMemo<HeroContext | null>(() => detail && {
    customer: h ? { id: h.customer.id, name: h.customer.name } : null,
    driver: detail.drivers?.[0] ? { id: detail.drivers[0].id, name: detail.drivers[0].displayName } : null,
    tasks: detail.view.workItems.filter((w) => w.status === "OPEN" || w.status === "NEEDS_EXTERNAL_INPUT").map((w) => ({ id: w.id, nextAction: w.nextAction, dueAt: w.dueAt })),
  }, [detail, h])
  const callbacks = story?.callbacks.filter((j) => j.status === "scheduled") ?? []

  return <AppFrame section="queue" snapshotAt={detail?.view.snapshotAt ?? null}><main className="page story-page">
    <nav className="crumbs" aria-label="Breadcrumb"><Link href="/">Needs you</Link><span>/</span><span className="mono">{reference ?? "Order"}</span></nav>
    {error && <div className="record-state" role="alert"><h1>{error}</h1><p>The order could not be opened. <Link href="/">Back to the queue</Link></p></div>}
    {!error && !story && <div aria-busy="true"><div className="q-skel tall" /><div className="q-skel" /><div className="q-skel" /><p className="empty">Loading the order…</p></div>}
    {story && <>
      <header className="story-head">
        <p className="eyebrow"><span className="mono">{story.reference}</span>{h ? <> · {h.statusLabel}</> : null}</p>
        <h1 className="page-title small">{h?.vehicle?.title ?? story.reference}</h1>
        {h && <p className="story-meta">{h.customer.name} · {h.from.city} <Icon name="arrow" size={13} /> {h.to.city}
          <Link className="link-quiet" href={`/orders/${id}/record`}>Full record</Link></p>}
      </header>
      <DecisionPanel story={story} ctx={ctx} onChanged={() => refresh()} />
      {callbacks.length > 0 && <p className="callbacks"><Icon name="waiting" size={14} />{callbacks.map((j) => <span key={j.id}>Ringo calls back <When at={j.dueAt} now={story.now} />: {j.reason}</span>)}</p>}
      <div id="ringo"><RunPanel story={story} onDone={() => refresh()} /></div>
      <FactsPanel story={story} />
      <Timeline story={story} />
    </>}
  </main></AppFrame>
}
