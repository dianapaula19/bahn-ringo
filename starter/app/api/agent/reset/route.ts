// Demo only: wipes ring_* rows and restarts the sim clock at the snapshot.
import { NextResponse } from "next/server"
import { reset } from "@/lib/agent/jobs"

export const runtime = "nodejs"

export async function POST() {
  return NextResponse.json(await reset())
}
