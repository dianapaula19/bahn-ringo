import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { readAttachmentManifest } from "@/lib/attachments"
import { db } from "@/lib/db"
import { orders } from "@/lib/schema"

export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, id)).limit(1)
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 })
  const attachments = (await readAttachmentManifest()).filter((attachment) => attachment.order_id === id)
  if (!attachments.length) return NextResponse.json({ attachments: [] })
  // Same-origin URLs (see ./[attachmentId]/route.ts) so files load wherever the app itself loads.
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? ""
  return NextResponse.json({ attachments: attachments.map((attachment) => ({ ...attachment, url: `${base}/api/orders/${id}/attachments/${attachment.id}` })) })
}
