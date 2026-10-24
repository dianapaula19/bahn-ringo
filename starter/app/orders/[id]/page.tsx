"use client"

import Link from "next/link"
import { use, useCallback, useEffect, useState } from "react"
import type { OrderStory } from "@/lib/contract"
import { loadStory } from "../../_lib/agent-api"
import { AppFrame } from "../../components/app-frame"
import { Icon } from "../../components/icons"
import type { Detail } from "../../components/order-detail"
import { When } from "../../components/ring/bits"
import { RunPanel } from "../../components/ring/run-panel"
import { DecisionPanel, FactsPanel, Timeline } from "../../components/ring/story"

export default function OrderStoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [story, setStory] = useState<OrderStory | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState("")

  const refresh = useCallback((signal?: AbortSignal) => loadStory(id, signal)
    .then((data) => { setStory(data); setError("") })
    .catch((e: unknown) => { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Could not load order") }), [id])

  useEffect(() => {
    const c = new AbortController()
    refresh(c.signal)
    fetch(`/api/orders/${encodeURIComponent(id)}`, { signal: c.signal }).then((r) => (r.ok ? r.json() as Promise<Detail> : null)).then(setDetail).catch(() => {})
    return () => c.abort()
  }, [id, refresh])

  const h = detail?.view.header
  const reference = story?.reference ?? h?.reference ?? null
  useEffect(() => { if (reference) document.title = `${reference} · ${h?.vehicle?.title ?? "Order"} · Ring` }, [reference, h])
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
      <DecisionPanel story={story} onChanged={() => refresh()} />
      {callbacks.length > 0 && <p className="callbacks"><Icon name="waiting" size={14} />{callbacks.map((j) => <span key={j.id}>Ring calls back <When at={j.dueAt} now={story.now} />: {j.reason}</span>)}</p>}
      <RunPanel story={story} onDone={() => refresh()} />
      <FactsPanel story={story} />
      <Timeline story={story} />
    </>}
  </main></AppFrame>
}
