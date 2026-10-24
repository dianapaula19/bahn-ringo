import { NextResponse } from "next/server"
import { recordRecoveryChoice } from "@/lib/agent/claims"
import { simNow } from "@/lib/agent/clock"

export const runtime = "nodejs"

/** POST {choice: "roadside" | "tow", note, operatorId}: record what the customer chose on a safety card. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const r = await recordRecoveryChoice(id, (await request.json().catch(() => null)) ?? {})
  return r.ok ? NextResponse.json({ now: await simNow(), ...r.value }) : NextResponse.json({ error: r.error }, { status: r.status })
}
