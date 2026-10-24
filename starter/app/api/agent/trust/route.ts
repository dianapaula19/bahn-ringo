import { NextResponse } from "next/server"
import type { TrustUpdateRequest } from "@/lib/contract"
import { simNow } from "@/lib/agent/clock"
import { ACTION_TYPES, ledger, updateTrust } from "@/lib/agent/trust"

export const runtime = "nodejs"

export async function GET() {
  const now = await simNow()
  return NextResponse.json({ now, rows: await ledger(now) })
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as TrustUpdateRequest | null
  if (!body || !ACTION_TYPES.includes(body.actionType) || !["auto", "ask", "never"].includes(body.mode) || !body.operatorId)
    return NextResponse.json({ error: "Send actionType, mode (auto, ask or never), operatorId and note." }, { status: 400 })
  const now = await simNow()
  const result = await updateTrust(body.actionType, body.mode, body.operatorId, now)
  return NextResponse.json({ now, ...result }, { status: "error" in result ? 409 : 200 })
}
