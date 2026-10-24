import { NextResponse } from "next/server"
import { handover, handoverText } from "@/lib/agent/handover"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const text = url.searchParams.get("format") === "text"
  const h = await handover(url.searchParams.get("since"), text) // cron/Telegram can wait for the Scribe; the page cannot
  if (text) return new Response(handoverText(h), { headers: { "content-type": "text/plain; charset=utf-8" } })
  return NextResponse.json(h)
}
