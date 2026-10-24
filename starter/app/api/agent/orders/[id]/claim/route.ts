import { NextResponse } from "next/server"
import { claimOrder, releaseClaim } from "@/lib/agent/claims"
import { simNow } from "@/lib/agent/clock"

export const runtime = "nodejs"

/** POST {by, note?, minutes?}: "I'll handle it". DELETE: hand it back to the queue. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const r = await claimOrder(id, (await request.json().catch(() => null)) ?? {})
  return r.ok ? NextResponse.json({ now: await simNow(), claim: r.value }) : NextResponse.json({ error: r.error }, { status: r.status })
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  await releaseClaim(id)
  return NextResponse.json({ now: await simNow(), ok: true })
}
