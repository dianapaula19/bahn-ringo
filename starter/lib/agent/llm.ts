// The one place Ring builds an Anthropic client. The key comes from the env
// (starter/.env.local, loaded by Next and by scripts/ring-shim.cjs). It is never logged or returned.
import Anthropic from "@anthropic-ai/sdk"

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"

const key = () => process.env.ANTHROPIC_API_KEY?.trim() || null

let client: Anthropic | null | undefined
export function anthropic(): Anthropic | null {
  if (client === undefined) {
    const apiKey = key()
    client = apiKey ? new Anthropic({ apiKey }) : null
  }
  return client
}

/** Common request extras: adaptive thinking, server-side refusal fallback (Claude API). */
export const BETAS = ["server-side-fallback-2026-07-01"]

/** One short model reply (Seller-Sim persona, Driver-Sim, Scribe). Null when offline or refused. */
export async function shortReply(system: string, user: string, effort: "low" | "medium" = "low"): Promise<string | null> {
  const c = anthropic()
  if (!c) return null
  const message = await c.beta.messages.create({
    model: MODEL, max_tokens: 2000, betas: BETAS, fallbacks: "default",
    thinking: { type: "adaptive" }, output_config: { effort },
    system, messages: [{ role: "user", content: user }],
  } as Anthropic.Beta.MessageCreateParamsNonStreaming)
  if (message.stop_reason === "refusal") return null
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim()
  return text || null
}
