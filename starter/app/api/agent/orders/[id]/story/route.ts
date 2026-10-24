import { NextResponse } from "next/server"
import { buildStory } from "@/lib/agent/story"

export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const story = await buildStory(id)
  return story ? NextResponse.json(story) : NextResponse.json({ error: "Order not found", code: "NOT_FOUND" }, { status: 404 })
}
