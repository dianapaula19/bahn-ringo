import { NextResponse } from "next/server"
import { handover, handoverText } from "@/lib/agent/handover"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const h = await handover(url.searchParams.get("since"))
  if (url.searchParams.get("format") === "text") return new Response(handoverText(h), { headers: { "content-type": "text/plain; charset=utf-8" } })
  return NextResponse.json(h)
}
