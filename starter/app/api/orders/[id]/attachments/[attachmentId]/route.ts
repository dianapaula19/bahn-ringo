import { GetObjectCommand } from "@aws-sdk/client-s3"
import { attachmentKey, readAttachmentManifest } from "@/lib/attachments"
import { objectStore } from "@/lib/object-store"

export const runtime = "nodejs"

// Streams one attachment through the app. Signed object-store URLs point at the store's own
// address (127.0.0.1:9009), which a browser can't reach when the app runs on a remote box (Matrix OS).
export async function GET(_request: Request, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  const { id, attachmentId } = await context.params
  const attachment = (await readAttachmentManifest()).find((a) => a.id === attachmentId && a.order_id === id)
  if (!attachment) return new Response("Not found", { status: 404 })
  const { client, bucket } = objectStore()
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: attachmentKey(attachment) }))
    const bytes = await object.Body!.transformToByteArray()
    return new Response(Buffer.from(bytes), {
      headers: { "content-type": attachment.content_type, "content-disposition": "inline", "cache-control": "private, max-age=900" },
    })
  } catch {
    return new Response("Attachment unavailable", { status: 502 })
  } finally {
    client.destroy()
  }
}
