// The one place Ring builds an Anthropic client. The key comes from the env
// (starter/.env.local, loaded by Next and by scripts/ring-shim.cjs). It is never logged or returned.
import AnthropicClient from "@anthropic-ai/sdk"
import { Anthropic } from "@posthog/ai/anthropic"
import { PostHog } from "posthog-node"

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"

const key = () => process.env.ANTHROPIC_API_KEY?.trim() || null
const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim()
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim()

const posthog = (() => {
  if (!projectToken || !host) {
    // PostHog is optional: without its env vars the app runs and sends nothing.
    return null
  }
  return new PostHog(projectToken, { host, privacyMode: false, flushAt: 1, flushInterval: 0 })
})()

export type AiTraceContext = { sessionId: string; traceId: string }
const processSessionId = `process-${process.pid}`
export const newAiTrace = (sessionId = processSessionId): AiTraceContext => ({ sessionId, traceId: crypto.randomUUID() })

let client: AnthropicClient | null | undefined
export function anthropic(): AnthropicClient | null {
  if (client === undefined) {
    const apiKey = key()
    client = apiKey ? posthog ? new Anthropic({ apiKey, posthog }) as unknown as AnthropicClient : new AnthropicClient({ apiKey }) : null
  }
  return client ?? null
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
    // Observability delivery must not change Ring's outcome.
  }
}

/** Common request extras: adaptive thinking, server-side refusal fallback (Claude API). */
export const BETAS = ["server-side-fallback-2026-07-01"]

/** One short model reply (Seller-Sim persona, Driver-Sim, Scribe). Null when offline or refused. */
export async function shortReply(system: string, user: string, effort: "low" | "medium" = "low", context = newAiTrace()): Promise<string | null> {
  const c = anthropic()
  if (!c) return null
  const message = await c.beta.messages.create({
    model: MODEL, max_tokens: 2000, betas: BETAS, fallbacks: "default",
    thinking: { type: "adaptive" }, output_config: { effort },
    system, messages: [{ role: "user", content: user }],
    posthogTraceId: context.traceId,
    posthogProperties: { $ai_session_id: context.sessionId },
  } as AnthropicClient.Beta.MessageCreateParamsNonStreaming)
  if (message.stop_reason === "refusal") return null
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim()
  return text || null
}
