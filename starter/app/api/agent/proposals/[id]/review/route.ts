import { NextResponse } from "next/server"
import type { ReviewRequest } from "@/lib/contract"
import { simNow } from "@/lib/agent/clock"
import { review } from "@/lib/agent/proposals"
import { triageOne } from "@/lib/agent/story"

export const runtime = "nodejs"

const DECISIONS = ["APPROVED", "EDITED", "REJECTED"]

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = (await request.json().catch(() => null)) as ReviewRequest | null
  if (!body || !DECISIONS.includes(body.decision) || !body.reviewerId) return NextResponse.json({ error: "Send decision (APPROVED, EDITED or REJECTED) and reviewerId." }, { status: 400 })
  const result = await review(id, body)
  if ("error" in result.body) return NextResponse.json(result.body, { status: result.status })
  const triage = await triageOne(result.body.proposal.orderId)
  return NextResponse.json({ now: await simNow(), ...result.body, triage })
}
