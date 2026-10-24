// The one place Ringo builds an Anthropic client. The key comes from the env
// (starter/.env.local, loaded by Next and by scripts/ring-shim.cjs). It is never logged or returned.
import AnthropicClient from "@anthropic-ai/sdk"
import { PostHog } from "posthog-node"
import { db } from "@/lib/db"
import { ringTurns } from "@/lib/ring-schema"

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"

const key = () => process.env.ANTHROPIC_API_KEY?.trim() || null
const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim()
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim()

const posthog = (() => {
  if (!projectToken || !host) {
    // PostHog is optional: without its env vars the app runs and sends nothing.
    return null
  }
  return new PostHog(projectToken, { host, flushAt: 1, flushInterval: 0 })
})()

export type AiTraceContext = { sessionId: string; traceId: string }
const processSessionId = `process-${process.pid}`
export const newAiTrace = (sessionId = processSessionId): AiTraceContext => ({ sessionId, traceId: crypto.randomUUID() })

let client: AnthropicClient | null | undefined
export function anthropic(): AnthropicClient | null {
  if (client === undefined) {
    const apiKey = key()
    client = apiKey ? new AnthropicClient({ apiKey }) : null
  }
  return client ?? null
}

type ModelResult = {
  model?: string; stop_reason?: string | null; content?: { type: string }[]
  usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null
}

// @posthog/ai only wraps `messages`, not `beta.messages`, and its posthog* request fields make the API
// answer 400. So Ringo reports each model call itself: model, tokens, latency, errors (no prompt content).
export function captureAiGeneration(context: AiTraceContext | null, name: string, startedAt: number, result: ModelResult | null, error?: unknown) {
  if (!posthog || !context) return
  posthog.capture({
    distinctId: `ai-${context.sessionId}`,
    event: "$ai_generation",
    properties: {
      $process_person_profile: false,
      $ai_trace_id: context.traceId,
      $ai_session_id: context.sessionId,
      $ai_span_name: name,
      $ai_provider: "anthropic",
      $ai_model: result?.model ?? MODEL,
      $ai_latency: (Date.now() - startedAt) / 1000,
      $ai_input_tokens: result?.usage?.input_tokens ?? 0,
      $ai_output_tokens: result?.usage?.output_tokens ?? 0,
      $ai_is_error: Boolean(error),
      ...(error ? { $ai_error: error instanceof Error ? error.name : "Error" } : {}),
    },
  })
}

/** Report one model call to PostHog and, inside a run (session id = run id), keep its timing and
 *  tokens in ring_turns for the engineering trace (/engine). A failed write never changes the run. */
export async function recordModelCall(context: AiTraceContext | null, name: string, startedAt: number, result: ModelResult | null, error?: unknown) {
  captureAiGeneration(context, name, startedAt, result, error)
  if (!context?.sessionId.startsWith("run-")) return
  const u = result?.usage
  try {
    await db.insert(ringTurns).values({
      id: `turn-${crypto.randomUUID()}`, runId: context.sessionId, name, model: result?.model ?? MODEL,
      startedAt: new Date(startedAt).toISOString(), latencyMs: Date.now() - startedAt,
      inputTokens: u?.input_tokens ?? null, outputTokens: u?.output_tokens ?? null,
      cacheReadTokens: u?.cache_read_input_tokens ?? null, cacheWriteTokens: u?.cache_creation_input_tokens ?? null,
      stopReason: result?.stop_reason ?? null, toolUses: result?.content ? result.content.filter((b) => b.type === "tool_use").length : null,
      error: error ? (error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "Error") : null,
    })
  } catch { /* the trace is best effort */ }
}

export function captureAiToolSpan(context: AiTraceContext | null, name: string, input: unknown, output: unknown, startedAt: number, isError = false) {
  if (!posthog || !context) return
  posthog.capture({
    distinctId: `ai-${context.sessionId}`,
    event: "$ai_span",
    properties: {
      $process_person_profile: false,
      $ai_trace_id: context.traceId,
      $ai_session_id: context.sessionId,
      $ai_span_id: crypto.randomUUID(),
      $ai_span_name: name,
      $ai_input_state: input,
      $ai_output_state: output,
      $ai_latency: (Date.now() - startedAt) / 1000,
      $ai_is_error: isError,
    },
  })
}

export async function flushAiObservability() {
  if (!posthog) return
  try {
    await posthog.flush()
  } catch {
    // Observability delivery must not change Ringo's outcome.
  }
}

/** Common request extras: adaptive thinking, server-side refusal fallback (Claude API). */
export const BETAS = ["server-side-fallback-2026-07-01"]

/** One short model reply (Seller-Sim persona, Driver-Sim, Scribe). Null when offline or refused. */
export async function shortReply(system: string, user: string, effort: "low" | "medium" = "low", context = newAiTrace()): Promise<string | null> {
  const c = anthropic()
  if (!c) return null
  const startedAt = Date.now()
  let message
  try {
    message = await c.beta.messages.create({
      model: MODEL, max_tokens: 2000, betas: BETAS, fallbacks: "default",
      thinking: { type: "adaptive" }, output_config: { effort },
      system, messages: [{ role: "user", content: user }],
    } as AnthropicClient.Beta.MessageCreateParamsNonStreaming)
    await recordModelCall(context, "short_reply", startedAt, message)
  } catch (e) {
    await recordModelCall(context, "short_reply", startedAt, null, e)
    throw e
  }
  if (message.stop_reason === "refusal") return null
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim()
  return text || null
}
