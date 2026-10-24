// A person edits or deletes one playbook note. The note keeps its source call; an edit is marked with who and when.
import { NextResponse } from "next/server"
import { simNow } from "@/lib/agent/clock"
import { deleteNote, editNote } from "@/lib/agent/playbook/playbook"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params
  const body = await req.json().catch(() => null) as { note?: unknown; editedBy?: unknown } | null
  const note = typeof body?.note === "string" ? body.note.trim() : ""
  const by = typeof body?.editedBy === "string" && body.editedBy.trim() ? body.editedBy.trim().slice(0, 60) : null
  if (!note || note.length > 300) return NextResponse.json({ error: "Write the note in one sentence, at most 300 characters.", code: "BAD_NOTE" }, { status: 400 })
  if (!by) return NextResponse.json({ error: "Say who edited it.", code: "NO_EDITOR" }, { status: 400 })
  const entry = await editNote(id, note, by)
  return entry ? NextResponse.json({ now: await simNow(), entry }) : NextResponse.json({ error: "Note not found." }, { status: 404 })
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params
  return (await deleteNote(id)) ? NextResponse.json({ now: await simNow(), deleted: id }) : NextResponse.json({ error: "Note not found." }, { status: 404 })
}
