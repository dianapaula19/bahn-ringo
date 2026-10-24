import { NextResponse } from "next/server"
import { SNAPSHOT, simNow } from "@/lib/agent/clock"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The desk clock (simulated, running from the snapshot) and when the data was frozen: the sidebar shows both on every page. */
export async function GET() {
  return NextResponse.json({ now: await simNow(), snapshotAt: SNAPSHOT })
}
