// Self-check for the savings formula (no DB):  npx tsx lib/savings.check.ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { computeSavings, DEFAULT_ESTIMATES, fmtSaved, helsinkiDay, parseEstimates } from "./savings"

test("line + hold + estimates; open calls and failed steps don't count", () => {
  const s = computeSavings({
    now: "2026-10-21T09:30:00.000Z", runs: 2, estimates: DEFAULT_ESTIMATES,
    calls: [
      { startedAt: "2026-10-21T09:00:00.000Z", endedAt: "2026-10-21T09:01:30.000Z", holdSeconds: 35 },
      { startedAt: "2026-10-21T09:10:00.000Z", endedAt: null, holdSeconds: 40 }, // still live: not counted
    ],
    toolResults: ["read_order", "read_messages", "read_docs", "record_fact", "record_fact", "send_driver_message", "place_call"],
  })
  assert.equal(s.calls, 1)
  assert.equal(s.lineSeconds, 90)
  assert.equal(s.holdSeconds, 35)
  assert.deepEqual([s.reads, s.notes, s.driverMessages], [3, 2, 1])
  assert.equal(s.estimateSeconds, (3 * 2 + 2 * 1 + 1 * 3) * 60)
  assert.equal(s.totalSeconds, 90 + 35 + 660)
})

test("estimates are validated at the edge", () => {
  assert.deepEqual(parseEstimates({ readMin: "2.3", driverMessageMin: 4, noteMin: 0 }), { readMin: 2.5, driverMessageMin: 4, noteMin: 0 })
  assert.equal(parseEstimates({ readMin: -1, driverMessageMin: 4, noteMin: 1 }), null)
  assert.equal(parseEstimates({ readMin: 61, driverMessageMin: 4, noteMin: 1 }), null)
  assert.equal(parseEstimates("nope"), null)
})

test("formatting and the Helsinki day", () => {
  assert.equal(fmtSaved(20), "under a minute")
  assert.equal(fmtSaved(24 * 60), "~24 min")
  assert.equal(fmtSaved(130 * 60), "~2 h 10 min")
  assert.equal(fmtSaved(120 * 60), "~2 h")
  assert.equal(helsinkiDay("2026-10-21T21:30:00.000Z"), "2026-10-22") // 00:30 EEST
})
