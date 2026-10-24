// Cron and the "Try now" button. ?force=1 fires every scheduled callback now (demo).
import { NextResponse } from "next/server"
import { runDue } from "@/lib/agent/jobs"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1"
  return NextResponse.json(await runDue({ wait: false, force }))
}
