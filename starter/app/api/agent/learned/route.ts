import { NextResponse } from "next/server"
import { simNow } from "@/lib/agent/clock"
import { listLearned } from "@/lib/agent/learn/store"
import type { LearnedResponse } from "@/lib/agent/learn/types"

export const runtime = "nodejs"

export async function GET() {
  const body: LearnedResponse = { now: await simNow(), rules: await listLearned() }
  return NextResponse.json(body)
}
