// Driver-Sim: the model plays the assigned driver, briefly, from a hidden
// script (or from the driver's recorded messages when no script exists). Simulated.
import type { SimScenario } from "@/lib/contract"
import { shortReply, type AiTraceContext } from "../llm"

export async function driverReply(input: {
  driverName: string; question: string; driver: SimScenario["driver"] | null; recent: string[]; ai: AiTraceContext | null
}): Promise<string> {
  const d = input.driver
  const knows = d?.knows ?? input.recent.map((m) => `You wrote earlier: "${m}"`)
  const system = [
    `You are ${d?.persona ?? `${input.driverName}, a freelance car delivery driver`}. This is a simulated driver chat in a training system; the sender is "Ringo", the operations assistant.`,
    "Reply in one or two short chat sentences. Answer only from what you know; otherwise say you don't know. Never invent places, times or names.",
    `What you know:\n- ${knows.join("\n- ") || "Nothing beyond the job you accepted."}`,
  ].join("\n\n")
  return (await shortReply(system, `Ringo asks: ${input.question}`, "low", input.ai ?? undefined)) ?? "Sorry, bad signal here. Will reply soon."
}
