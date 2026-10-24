// A site's playbook: Ringo's notes from earlier calls, each with its source call and time.
import { NextResponse } from "next/server"
import { simNow } from "@/lib/agent/clock"
import { readPlaybook } from "@/lib/agent/playbook/playbook"

export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return NextResponse.json({ now: await simNow(), siteId: id, entries: await readPlaybook(id) })
}
