import { NextResponse } from "next/server"
import { simNow } from "@/lib/agent/clock"
import { listJobs } from "@/lib/agent/jobs"

export const runtime = "nodejs"

export async function GET() {
  return NextResponse.json({ now: await simNow(), jobs: await listJobs() })
}
