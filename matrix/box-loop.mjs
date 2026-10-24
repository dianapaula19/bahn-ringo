// Ringo background loop for a Matrix OS box (or any always-on machine).
//   every 5 min : triage + due callbacks  (scripts/background.ts, else POST /api/agent/jobs/run-due)
//   07:00 local : "Since you left" handover -> Telegram, delivered by Matrix's own channel
//
// Why a loop and not Matrix cron: in the Matrix source (gateway server.ts, cron onTrigger) a
// cron job only delivers its fixed `message` text to a channel. It cannot run a command.
// So the clock lives here, and Telegram delivery is a one-shot Matrix cron job (POST /api/cron).
//
// Run from starter/:  node --env-file-if-exists=../../.env --env-file-if-exists=.env ../matrix/box-loop.mjs
// Flags: --register [cron.json] (add Matrix cron entries)  --once (one tick, then exit)  --dry (print instead of sending)  --check (self-test)
// Env:   APP_URL (default http://127.0.0.1:3000), RING_TZ (Europe/Helsinki),
//        MATRIX_GATEWAY_URL (default http://127.0.0.1:4000), MATRIX_TOKEN, TELEGRAM_CHAT_ID
//        Telegram is off unless both MATRIX_TOKEN and TELEGRAM_CHAT_ID are set.
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const APP = process.env.APP_URL ?? "http://127.0.0.1:3000"
const TZ = process.env.RING_TZ ?? "Europe/Helsinki"
const GW = process.env.MATRIX_GATEWAY_URL ?? "http://127.0.0.1:4000"
const STATE = process.env.RING_LOOP_STATE ?? join(homedir(), ".bahn-ring-loop.json")
const TICK_MS = 5 * 60_000
const DRY = process.argv.includes("--dry")

// Local day + minutes-since-midnight in `tz`.
export function localClock(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(ms).map((x) => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) }
}

// A daily job is due once per local day, inside a 60 min window after its time (so a restart at
// 23:00 does not fire the 07:00 job late). Returns the day to mark as done, or null.
export function due(ms, hhmm, tz, lastDay) {
  const [h, m] = hhmm.split(":").map(Number)
  const { day, min } = localClock(ms, tz)
  const t = h * 60 + m
  return day !== lastDay && min >= t && min < t + 60 ? day : null
}

function loadState() { try { return JSON.parse(readFileSync(STATE, "utf8")) } catch { return {} } }
function saveState(s) { writeFileSync(STATE, JSON.stringify(s)) }

// Delivery goes through Matrix: a one-shot cron job fires immediately and removes itself
// (cron/service.ts "once" branch). Our code never calls Telegram directly.
export async function sendViaMatrix(name, text) {
  const token = process.env.MATRIX_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID
  const body = {
    name, message: text.slice(0, 3500),
    schedule: { type: "once", at: new Date().toISOString() },
    target: { channel: "telegram", chatId: chatId ?? "" },
  }
  if (DRY || !token || !chatId) { console.log(`[matrix] would send ${name}:\n${body.message}`); return }
  const r = await fetch(`${GW}/api/cron`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  })
  console.log(`[matrix] ${name} -> ${r.status}`)
}

// cron.json holds local times + "tz". Matrix's node-cron gets no timezone (cron/service.ts), so it
// runs in the gateway process TZ, ASSUMED UTC. Shift the hour using the offset at the next
// occurrence (now + 24h), which lands right across the 25 Oct 2026 EEST->EET switch.
export function utcCron(expr, tz, ms = Date.now()) {
  const [m, h, ...rest] = expr.split(" ")
  const at = ms + 24 * 3600_000
  const local = localClock(at, tz).min, utc = new Date(at).getUTCHours() * 60 + new Date(at).getUTCMinutes()
  const off = Math.round(((local - utc + 1440 + 720) % 1440 - 720) / 60)
  return [m, String((Number(h) - off + 24) % 24), ...rest].join(" ")
}

// Register cron.json entries that are not there yet (matched by name). POST /api/cron is used,
// not a file edit: the gateway re-reads cron.json from a cache, so file edits only apply after a
// gateway restart (cron/store.ts list() + server.ts watcher).
async function register(file) {
  const token = process.env.MATRIX_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID
  if (!token) throw new Error("MATRIX_TOKEN is not set")
  const auth = { Authorization: `Bearer ${token}` }
  const existing = new Set((await (await fetch(`${GW}/api/cron`, { headers: auth })).json()).map((j) => j.name))
  for (const { tz, ...job } of JSON.parse(readFileSync(file, "utf8"))) {
    if (existing.has(job.name)) { console.log(`[cron] ${job.name} exists`); continue }
    if (job.target?.chatId === "${TELEGRAM_CHAT_ID}") {
      if (!chatId) { console.log(`[cron] ${job.name} skipped: TELEGRAM_CHAT_ID not set`); continue }
      job.target.chatId = chatId
    }
    if (tz && job.schedule.type === "cron") job.schedule.cron = utcCron(job.schedule.cron, tz)
    if (DRY) { console.log(`[cron] would add ${JSON.stringify({ ...job, target: job.target && { ...job.target, chatId: "<set>" } })}`); continue }
    const r = await fetch(`${GW}/api/cron`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(job) })
    console.log(`[cron] ${job.name} -> ${r.status}`)
  }
}

function triage() {
  if (existsSync("scripts/background.ts")) {
    // ring-shim maps "server-only" and loads .env/.env.local, same as `npm run ring:background`.
    const r = spawnSync("npx", ["tsx", "--require", "./scripts/ring-shim.cjs", "scripts/background.ts"], { stdio: "inherit" })
    return console.log(`[triage] background.ts exit ${r.status}`)
  }
  return fetch(`${APP}/api/agent/jobs/run-due`, { method: "POST" })
    .then((r) => console.log(`[triage] run-due ${r.status}`))
}

async function tick() {
  const now = Date.now()
  try { await triage() } catch (e) { console.error(`[triage] ${e.message}`) }
  const s = loadState()
  const day = due(now, "07:00", TZ, s.handover)
  if (day) {
    try {
      const r = await fetch(`${APP}/api/agent/handover?format=text`)
      if (!r.ok) throw new Error(`handover ${r.status}`)
      const text = (await r.text()).trim() || "Nothing changed since you left."
      await sendViaMatrix(`bahn-ring-handover-${day}`, `Ringo handover, ${day} 07:00 ${TZ}\n\n${text}`)
      if (!DRY) saveState({ ...s, handover: day })
    } catch (e) { console.error(`[handover] ${e.message}`) }
  }
}

if (process.argv.includes("--check")) {
  const at = (iso) => Date.parse(iso)
  // 2026-10-24 is EEST (UTC+3); 2026-10-26 is EET (UTC+2) after the 25 Oct switch.
  assert.equal(due(at("2026-10-24T04:00:00Z"), "07:00", "Europe/Helsinki", null), "2026-10-24", "fires at 07:00 EEST")
  assert.equal(due(at("2026-10-24T03:59:00Z"), "07:00", "Europe/Helsinki", null), null, "not before")
  assert.equal(due(at("2026-10-24T04:30:00Z"), "07:00", "Europe/Helsinki", "2026-10-24"), null, "once per day")
  assert.equal(due(at("2026-10-24T05:00:00Z"), "07:00", "Europe/Helsinki", null), null, "window closes after 60 min")
  assert.equal(due(at("2026-10-26T05:10:00Z"), "07:00", "Europe/Helsinki", null), "2026-10-26", "07:10 EET")
  assert.equal(utcCron("0 7 * * *", "Europe/Helsinki", at("2026-10-23T12:00:00Z")), "0 4 * * *", "EEST tomorrow")
  assert.equal(utcCron("0 7 * * *", "Europe/Helsinki", at("2026-10-24T12:00:00Z")), "0 5 * * *", "EET after switch")
  assert.equal(utcCron("30 22 * * *", "Europe/Helsinki", at("2026-11-01T12:00:00Z")), "30 20 * * *", "evening")
  console.log("box-loop check ok")
} else if (process.argv.includes("--register")) {
  await register(process.argv[process.argv.indexOf("--register") + 1] ?? "../matrix/cron.json")
} else if (process.argv.includes("--once")) {
  await tick()
} else {
  console.log(`[ring-loop] app ${APP}, tz ${TZ}, tick ${TICK_MS / 60000} min, telegram ${process.env.MATRIX_TOKEN && process.env.TELEGRAM_CHAT_ID ? "on" : "off"}`)
  await tick()
  setInterval(tick, TICK_MS)
}
