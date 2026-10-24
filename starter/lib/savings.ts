// Time Ringo saved a person. Pure, so the sidebar, /trust and the self-check share one formula:
//   saved = time on the simulated line + IVR hold time (the sim announces holds, it doesn't sit them out)
//         + reads × readMin + driver messages × driverMessageMin + notes written × noteMin
// The per-step minutes are an estimate a person sets on /trust (stored in ring_meta), not a measurement.

export type SavingsEstimates = { readMin: number; driverMessageMin: number; noteMin: number }

export const DEFAULT_ESTIMATES: SavingsEstimates = { readMin: 2, driverMessageMin: 3, noteMin: 1 }

export const ESTIMATE_LABELS: Record<keyof SavingsEstimates, string> = {
  readMin: "Reading an order, its messages or papers",
  driverMessageMin: "Messaging the driver and waiting for the reply",
  noteMin: "Writing down one fact",
}

export type SavingsCall = { startedAt: string; endedAt: string | null; holdSeconds: number }

export type Savings = {
  now: string
  /** The sim day counted, Helsinki time: "2026-10-21". */
  day: string
  runs: number
  calls: number
  lineSeconds: number
  holdSeconds: number
  reads: number
  driverMessages: number
  notes: number
  estimates: SavingsEstimates
  estimateSeconds: number
  totalSeconds: number
}

export const READ_TOOLS = new Set(["read_order", "read_messages", "read_docs"])

/** The Helsinki calendar day of an ISO time: the control room's "today". */
export const helsinkiDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki" }).format(new Date(iso))

/** `toolResults`: the tool name of every successful tool result in today's runs. */
export function computeSavings(input: { now: string; runs: number; calls: SavingsCall[]; toolResults: string[]; estimates: SavingsEstimates }): Savings {
  const ended = input.calls.filter((c) => c.endedAt)
  const lineSeconds = ended.reduce((s, c) => s + Math.max(0, (Date.parse(c.endedAt!) - Date.parse(c.startedAt)) / 1000), 0)
  const holdSeconds = ended.reduce((s, c) => s + c.holdSeconds, 0)
  const count = (pred: (t: string) => boolean) => input.toolResults.filter(pred).length
  const reads = count((t) => READ_TOOLS.has(t))
  const driverMessages = count((t) => t === "send_driver_message")
  const notes = count((t) => t === "record_fact")
  const e = input.estimates
  const estimateSeconds = (reads * e.readMin + driverMessages * e.driverMessageMin + notes * e.noteMin) * 60
  return {
    now: input.now, day: helsinkiDay(input.now), runs: input.runs, calls: ended.length,
    lineSeconds: Math.round(lineSeconds), holdSeconds, reads, driverMessages, notes, estimates: e,
    estimateSeconds, totalSeconds: Math.round(lineSeconds + holdSeconds + estimateSeconds),
  }
}

/** Clean estimates from storage or a form: 0 to 60 minutes each, in half minutes. Null when unusable. */
export function parseEstimates(value: unknown): SavingsEstimates | null {
  if (!value || typeof value !== "object") return null
  const out = { ...DEFAULT_ESTIMATES }
  for (const k of Object.keys(DEFAULT_ESTIMATES) as (keyof SavingsEstimates)[]) {
    const n = Number((value as Record<string, unknown>)[k])
    if (!Number.isFinite(n) || n < 0 || n > 60) return null
    out[k] = Math.round(n * 2) / 2
  }
  return out
}

/** "~2 h 10 min", "~24 min", "under a minute". */
export function fmtSaved(seconds: number): string {
  const min = Math.round(seconds / 60)
  if (min < 1) return "under a minute"
  const h = Math.floor(min / 60)
  return `~${h ? `${h} h ` : ""}${h && min % 60 === 0 ? "" : `${min % 60} min`}`.trim()
}

/** "4 min 10 s", "35 s": the measured parts, a little more exact. */
export function fmtSeconds(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
}
