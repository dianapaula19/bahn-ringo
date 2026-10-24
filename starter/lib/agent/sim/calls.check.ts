// Self-checks for the call rules (node:test, no DB, no model):
// line language, the escalation ladder's stop rules, the menu walk, the path diagram,
// the quote check, and the speech gate on translated lines.
//   npx tsx lib/agent/sim/calls.check.ts   (also part of npm run ring:check)
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { CallTurn } from "@/lib/contract"
import { checkSpeech } from "../gate"
import { checkBoth, findQuote, ladderCheck, langForCountry, pathOf, pathText, type LadderCall } from "./calls"
import { scenarioFor, walk } from "./scenarios"

const site = (id: string, country: string, name = "Test site") => ({ id, name, details: { country, timezone: "Europe/Helsinki", opening_hours: { mon_fri: "08:30-19:00" } } })

describe("line language by country", () => {
  test("DE German, DK Danish, FI Finnish, others English", () => {
    assert.deepEqual(["DE", "DK", "FI", "FR", "SE", "", null].map(langForCountry), ["de", "da", "fi", "en", "en", "en", "en"])
  })
  test("516's Helsinki site answers in Finnish, 010's Frankfurt site in German, a Danish site's menu in Danish", () => {
    const fi = scenarioFor("ord-00516", site("site-001", "FI", "Velantora Helsinki"))
    assert.ok(fi.personas.every((p) => p.language === "fi"))
    assert.equal(fi.ivr.nodes.main.language, "fi")
    assert.ok((fi.ivr.nodes.main as { en?: string }).en?.startsWith("Welcome to Velantora Helsinki"))
    assert.ok(scenarioFor("ord-00010", site("site-039", "DE")).personas.every((p) => p.language === "de"))
    assert.match(scenarioFor("ord-x", site("site-057", "DK", "Norveldin Copenhagen")).ivr.nodes.main.prompt, /^Velkommen til Norveldin Copenhagen/)
  })
})

describe("escalation ladder (stop rules in code)", () => {
  const base = { runId: "run-1", open: true, hoursText: "Mon–Fri 08:30-19:00", safety: false, why: null as string | null }
  const call = (rung: LadderCall["rung"], outcome: LadderCall["outcome"] = "ANSWERED", runId = "run-1"): LadderCall => ({ rung, outcome, runId })
  test("starts at the desk or stock control, never the manager", () => {
    assert.equal(ladderCheck({ ...base, target: "site_desk", prior: [] }), null)
    assert.equal(ladderCheck({ ...base, target: "stock_control", prior: [] }), null)
    assert.match(ladderCheck({ ...base, target: "branch_manager", prior: [] })!, /^Ladder stop: I never start at the branch manager/)
  })
  test("climbs one rung at a time, and only with a reason", () => {
    assert.match(ladderCheck({ ...base, target: "branch_manager", prior: [call("site_desk")], why: "desk can't" })!, /one rung at a time/)
    assert.match(ladderCheck({ ...base, target: "stock_control", prior: [call("site_desk")] })!, /needs a reason/)
    assert.equal(ladderCheck({ ...base, target: "stock_control", prior: [call("site_desk")], why: "The desk doesn't hold keys." }), null)
    assert.equal(ladderCheck({ ...base, target: "branch_manager", prior: [call("stock_control")], why: "Stock can't find the VIN." }), null)
  })
  test("at most 2 attempts per rung on an order, 3 calls per run", () => {
    assert.match(ladderCheck({ ...base, target: "site_desk", prior: [call("site_desk", "DROPPED_UNKNOWN", "run-0"), call("site_desk", "NO_ANSWER", "run-0")] })!, /No third try/)
    assert.equal(ladderCheck({ ...base, target: "site_desk", prior: [call("site_desk", "DROPPED_UNKNOWN", "run-0")] }), null)
    assert.match(ladderCheck({ ...base, target: "branch_manager", why: "x", prior: [call("site_desk"), call("stock_control"), call("stock_control")] })!, /3 calls in one run/)
  })
  test("never while the site is closed, never climbing on safety", () => {
    assert.match(ladderCheck({ ...base, open: false, target: "site_desk", prior: [] })!, /closed right now \(Mon–Fri 08:30-19:00\)/)
    assert.equal(ladderCheck({ ...base, safety: true, target: "site_desk", prior: [] }), null)
    assert.match(ladderCheck({ ...base, safety: true, target: "stock_control", prior: [call("site_desk")], why: "x" })!, /safety/)
  })
})

describe("menu walk and path diagram", () => {
  const sc = scenarioFor("ord-00516", site("site-001", "FI", "Velantora Helsinki"))
  test("type-ahead digits land on the right rung", () => {
    assert.equal(walk(sc.ivr, "main", "32").rung, "stock_control")
    assert.equal(walk(sc.ivr, "main", "32").end.id, "stock")
    assert.equal(walk(sc.ivr, "main", "9").rung, "branch_manager")
    assert.equal(walk(sc.ivr, "main", "0").rung, "site_desk")
    assert.equal(walk(sc.ivr, "main", "31").rung, "site_desk")
    assert.equal(walk(sc.ivr, "main", "7").bad, "7")
  })
  test("the path reads like the call went", () => {
    const at = "2026-10-21T09:10:00.000Z"
    const t = [
      { at, speaker: "system", text: "Rung 2 of 3", rung: "stock_control" },
      { at, speaker: "ivr", text: "Tervetuloa", heard: "menu", label: "Main menu" },
      { at, speaker: "ring", text: "Pressed 3", dtmf: "3" },
      { at, speaker: "ivr", text: "Ajoneuvojen nouto", heard: "menu", label: "Collections" },
      { at, speaker: "ring", text: "Pressed 2", dtmf: "2" },
      { at, speaker: "ivr", text: "Pitomusiikkia", heard: "hold", seconds: 35 },
      { at, speaker: "ring", text: "(waits)" },
      { at, speaker: "site", text: "Varasto, Ilona puhelimessa.", heard: "human", label: "Stock control", who: "Ilona Alderbrook, stock control lead" },
      { at, speaker: "site", text: "Avaimet ovat varaston avainkaapissa.", heard: "human", who: "Ilona Alderbrook, stock control lead" },
    ] as CallTurn[]
    assert.equal(pathText(pathOf(t)), "Main menu → press 3 → Collections → press 2 → hold 35 s → Stock control → Ilona Alderbrook, stock control lead")
    assert.equal(findQuote("avaimet ovat varaston avainkaapissa", t)?.text, "Avaimet ovat varaston avainkaapissa.")
    assert.equal(findQuote("“Avaimet  ovat varaston avainkaapissa.”", t)?.at, at)
    assert.equal(findQuote("The keys are in the stock cabinet", t), null, "a paraphrase is not a quote")
    assert.equal(findQuote("Tervetuloa", t), null, "only what a person said counts")
  })
})

describe("speech gate on another language", () => {
  test("a German line is checked on its English translation", () => {
    assert.equal(checkSpeech("Bitte starten Sie den Motor neu."), null, "the English rules alone miss it")
    assert.match(checkBoth(checkSpeech, "Bitte starten Sie den Motor neu.", "Please restart the engine.")!, /CL-01/)
    assert.equal(checkBoth(checkSpeech, "Wer hat die Schlüssel?", "Who has the keys?"), null)
  })
})
