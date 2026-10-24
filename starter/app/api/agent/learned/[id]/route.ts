import { NextResponse } from "next/server"
import { decideLearned } from "@/lib/agent/learn/store"
import type { LearnedDecision } from "@/lib/agent/learn/types"

export const runtime = "nodejs"

const ACTIONS = ["accept", "dismiss", "off", "on", "edit"]

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = (await request.json().catch(() => null)) as LearnedDecision | null
  if (!body || !ACTIONS.includes(body.action) || !body.operatorId)
    return NextResponse.json({ error: "Send action (accept, dismiss, off, on or edit), operatorId, and text for edit." }, { status: 400 })
  const result = await decideLearned(id, body)
  return NextResponse.json(result.body, { status: result.status })
}
