import { NextResponse } from "next/server"
import { buildQueue } from "@/lib/agent/story"

export const runtime = "nodejs"

export async function GET() {
  return NextResponse.json(await buildQueue())
}
