// Client calls to /api/agent/* (CONTRACT §7).
import type {
  ActionType, Desk, Handover, OrderStory, QueueResponse, ReviewRequest, RunDetail, RunEvent, RunRequest, TrustLedger, TrustMode, TrustUpdateResponse,
} from "@/lib/contract"

import { withBase } from "@/lib/base"
import type { LearnedDecision, LearnedDecisionResponse, LearnedResponse, ReviewWithSuggestion } from "@/lib/agent/learn/types"
import type { Claim } from "@/lib/triage/claim"

export const DESK: Desk = "ops-readiness"

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try { res = await fetch(withBase(url), { signal, cache: "no-store" }) } catch (e) {
    if (signal?.aborted) throw e
    throw new Error("Could not reach the control room")
  }
  const body = await res.json().catch(() => null)
  if (!res.ok || !body) throw new Error(res.status === 404 ? "Order not found" : body?.error ?? "Could not load")
  return body as T
}

async function post<T>(url: string, body: unknown): Promise<T> {
  let res: Response
  try { res = await fetch(withBase(url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) } catch {
    return { error: "Could not reach the control room." } as T
  }
  return res.json().catch(() => ({ error: "The control room sent an unreadable answer." }) as T)
}

export const loadQueue = (signal?: AbortSignal) => get<QueueResponse>("/api/agent/queue", signal)
export const loadStory = (id: string, signal?: AbortSignal) => get<OrderStory>(`/api/agent/orders/${encodeURIComponent(id)}/story`, signal)
export const loadTrust = (signal?: AbortSignal) => get<TrustLedger>("/api/agent/trust", signal)
export const loadHandover = (since: string | null, signal?: AbortSignal) =>
  get<Handover>(`/api/agent/handover${since ? `?since=${encodeURIComponent(since)}` : ""}`, signal)

export const reviewProposal = (id: string, req: ReviewRequest) =>
  post<ReviewWithSuggestion>(`/api/agent/proposals/${encodeURIComponent(id)}/review`, req)

export const claimOrder = (orderId: string, note: string, minutes: number) =>
  post<{ claim: Claim } | { error: string }>(`/api/agent/orders/${encodeURIComponent(orderId)}/claim`, { by: DESK, note, minutes })
export async function releaseClaim(orderId: string): Promise<boolean> {
  try { return (await fetch(withBase(`/api/agent/orders/${encodeURIComponent(orderId)}/claim`), { method: "DELETE" })).ok } catch { return false }
}
export const recordRecovery = (orderId: string, choice: "roadside" | "tow", note: string) =>
  post<{ then: string } | { error: string }>(`/api/agent/orders/${encodeURIComponent(orderId)}/recovery`, { choice, note, operatorId: DESK })

export const loadLearned = (signal?: AbortSignal) => get<LearnedResponse>("/api/agent/learned", signal)
export const decideLearned = (id: string, action: LearnedDecision["action"], text?: string) =>
  post<LearnedDecisionResponse>(`/api/agent/learned/${encodeURIComponent(id)}`, { action, text, operatorId: DESK } satisfies LearnedDecision)

export const updateTrust = (actionType: ActionType, mode: TrustMode, note: string) =>
  post<TrustUpdateResponse>("/api/agent/trust", { actionType, mode, operatorId: DESK, note })

/** Runs Ringo. A replay streams NDJSON; a live run starts with a short POST and is then polled (see pollRun). */
export async function runRing(orderId: string, req: RunRequest, onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<void> {
  const fail = (message: string, retryable: boolean) => onEvent({ type: "error", message, retryable, at: new Date().toISOString() })
  let res: Response
  try {
    res = await fetch(withBase(`/api/agent/orders/${encodeURIComponent(orderId)}/run`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal })
  } catch { if (!signal?.aborted) fail("Could not reach the control room.", true); return }
  if (res.status === 409) return fail("Ringo is already working on this order.", false)
  if (!res.ok || !res.body) { const b = await res.json().catch(() => null); return fail(b?.error ?? "Ringo could not start.", true) }
  if (req.trigger !== "replay") return pollRun(res, onEvent, fail, signal)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    const lines = buf.split("\n"); buf = lines.pop()!
    for (const l of lines) if (l.trim()) onEvent(JSON.parse(l) as RunEvent)
  }
  if (buf.trim()) onEvent(JSON.parse(buf) as RunEvent)
}

/** A live run outlasts a proxy's per-request cap (30 s on Matrix OS), so no request is long:
 *  the POST answers {runId} once started, then GET /runs/[runId]?after=<seq> every second until run_ended. */
async function pollRun(res: Response, onEvent: (e: RunEvent) => void, fail: (m: string, r: boolean) => void, signal?: AbortSignal): Promise<void> {
  const start = await res.json().catch(() => null) as { runId?: string; events?: RunEvent[] } | null
  if (!start?.runId) return fail("Ringo could not start.", true)
  if (start.events) { start.events.forEach(onEvent); return } // ended before starting (offline)
  let seen = 0, misses = 0
  while (!signal?.aborted) {
    let detail: RunDetail
    try { detail = await get<RunDetail>(`/api/agent/runs/${encodeURIComponent(start.runId)}?after=${seen - 1}`, signal); misses = 0 } catch {
      if (signal?.aborted) return
      if (++misses >= 10) return fail("The connection to Ringo was lost. The run goes on; reload the order to see what was saved.", true)
      await new Promise((r) => setTimeout(r, 1000)); continue
    }
    for (const e of detail.events) { seen++; onEvent(e); if (e.type === "run_ended") return }
    if (detail.run.status !== "running" && detail.events.length === 0) return // ended without a run_ended line
    await new Promise((r) => setTimeout(r, 1000))
  }
}
