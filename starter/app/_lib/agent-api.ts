// Client calls to /api/agent/* (CONTRACT §7).
import type {
  ActionType, Desk, Handover, OrderStory, QueueResponse, ReviewRequest, ReviewResponse, RunEvent, RunRequest, TrustLedger, TrustMode, TrustUpdateResponse,
} from "@/lib/contract"

export const DESK: Desk = "ops-readiness"

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try { res = await fetch(url, { signal, cache: "no-store" }) } catch (e) {
    if (signal?.aborted) throw e
    throw new Error("Could not reach the control room")
  }
  const body = await res.json().catch(() => null)
  if (!res.ok || !body) throw new Error(res.status === 404 ? "Order not found" : body?.error ?? "Could not load")
  return body as T
}

async function post<T>(url: string, body: unknown): Promise<T> {
  let res: Response
  try { res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) } catch {
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
  post<ReviewResponse>(`/api/agent/proposals/${encodeURIComponent(id)}/review`, req)

export const updateTrust = (actionType: ActionType, mode: TrustMode, note: string) =>
  post<TrustUpdateResponse>("/api/agent/trust", { actionType, mode, operatorId: DESK, note })

/** Streams a run as NDJSON, one RunEvent per line. */
export async function runRing(orderId: string, req: RunRequest, onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<void> {
  const fail = (message: string, retryable: boolean) => onEvent({ type: "error", message, retryable, at: new Date().toISOString() })
  let res: Response
  try {
    res = await fetch(`/api/agent/orders/${encodeURIComponent(orderId)}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal })
  } catch { if (!signal?.aborted) fail("Could not reach the control room.", true); return }
  if (res.status === 409) return fail("Ring is already working on this order.", false)
  if (!res.ok || !res.body) { const b = await res.json().catch(() => null); return fail(b?.error ?? "Ring could not start.", true) }
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
