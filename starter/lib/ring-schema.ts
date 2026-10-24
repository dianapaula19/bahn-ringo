// Ringo's own tables. No foreign keys to starter tables: the starter's reseed
// TRUNCATEs its tables and must keep working. Order ids are plain text.
import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" })

export const ringMeta = pgTable("ring_meta", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
})

export const ringRuns = pgTable("ring_runs", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  trigger: text("trigger").notNull(),
  status: text("status").notNull(),
  model: text("model").notNull(),
  operatorMessage: text("operator_message"),
  decision: jsonb("decision"),
  error: text("error"),
  startedAt: ts("started_at").notNull(),
  endedAt: ts("ended_at"),
})

export const ringSteps = pgTable("ring_steps", {
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  event: jsonb("event").notNull(),
  /** Real (wall) clock when the step was written, for the trace's tool latency. Null on older rows. */
  wallAt: ts("wall_at"),
}, (t) => [primaryKey({ columns: [t.runId, t.seq] })])

export const ringCalls = pgTable("ring_calls", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  orderId: text("order_id").notNull(),
  siteId: text("site_id").notNull(),
  number: text("number").notNull(),
  purpose: text("purpose").notNull(),
  status: text("status").notNull(),
  outcome: text("outcome"),
  ivrPath: jsonb("ivr_path").notNull(),
  transcript: jsonb("transcript").notNull(),
  reconciledFrom: jsonb("reconciled_from"),
  startedAt: ts("started_at").notNull(),
  endedAt: ts("ended_at"),
})

export const ringDriverMessages = pgTable("ring_driver_messages", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  orderId: text("order_id").notNull(),
  driverId: text("driver_id").notNull(),
  direction: text("direction").notNull(),
  intent: text("intent").notNull(),
  body: text("body").notNull(),
  proposalId: text("proposal_id"),
  at: ts("at").notNull(),
})

export const ringFacts = pgTable("ring_facts", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  runId: text("run_id"),
  subject: text("subject").notNull(),
  claim: text("claim").notNull(),
  level: text("level").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id").notNull(),
  by: text("by").notNull(),
  at: ts("at").notNull(),
  supersededByFactId: text("superseded_by_fact_id"),
  note: text("note"),
})

export const ringProposals = pgTable("ring_proposals", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  runId: text("run_id"),
  command: text("command").notNull(),
  actionType: text("action_type").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  alertId: text("alert_id"),
  proposedPayload: jsonb("proposed_payload").notNull(),
  rationale: text("rationale").notNull(),
  summary: text("summary").notNull(),
  evidenceRefs: jsonb("evidence_refs").notNull(),
  dependency: jsonb("dependency").notNull(),
  status: text("status").notNull(),
  review: jsonb("review"),
  execution: jsonb("execution"),
  supersededByProposalId: text("superseded_by_proposal_id"),
  onApprove: text("on_approve"),
  onReject: text("on_reject"),
  gate: jsonb("gate"),
  trustMode: text("trust_mode"),
  createdAt: ts("created_at").notNull(),
})

export const ringEvents = pgTable("ring_events", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  at: ts("at").notNull(),
  command: text("command").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  proposalId: text("proposal_id"),
  changes: jsonb("changes").notNull(),
  sourceRefs: jsonb("source_refs").notNull(),
})

export const ringTrust = pgTable("ring_trust", {
  actionType: text("action_type").primaryKey(),
  mode: text("mode").notNull(),
  locked: boolean("locked").notNull(),
  lockedReason: text("locked_reason"),
  updatedAt: ts("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
})

export const ringJobs = pgTable("ring_jobs", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  dueAt: ts("due_at").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  createdByRunId: text("created_by_run_id").notNull(),
  firedRunId: text("fired_run_id"),
})

// Ringo learns from your edits (lib/agent/learn). One row per corrected field (EDITED)
// or per rejection. Kept across a demo reset: it is the review record the rules cite.
export const ringCorrections = pgTable("ring_corrections", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  orderId: text("order_id").notNull(),
  orderRef: text("order_ref").notNull(),
  actionType: text("action_type").notNull(),
  kind: text("kind").notNull(), // edit | reject
  field: text("field"),
  before: jsonb("before"),
  after: jsonb("after"),
  reasonClass: text("reason_class"),
  note: text("note").notNull(),
  situation: jsonb("situation").notNull(), // open alert signals + open work item kinds at review time
  patternKey: text("pattern_key").notNull(),
  reviewerId: text("reviewer_id").notNull(),
  at: ts("at").notNull(),
})

// A pattern Ringo noticed: suggested → active (CL-Lxx in the gate) ↔ off, or dismissed for good.
export const ringLearnedRules = pgTable("ring_learned_rules", {
  id: text("id").primaryKey(),
  patternKey: text("pattern_key").notNull().unique(),
  ruleId: text("rule_id").unique(), // CL-L01…, set on accept
  status: text("status").notNull(),
  version: integer("version").notNull(),
  actionType: text("action_type").notNull(),
  spec: jsonb("spec").notNull(),
  title: text("title").notNull(),
  text: text("text").notNull(),
  ask: text("ask").notNull(),
  correctionIds: jsonb("correction_ids").notNull(),
  history: jsonb("history").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
})

// Site playbooks: what Ringo learned about a site's phone line and handover,
// one row per note, each sourced to the Ringo call (and the moment) it came from.
// A person can edit or delete a note on the site page. Wiped by the demo reset.
export const ringPlaybooks = pgTable("ring_playbooks", {
  id: text("id").primaryKey(),
  siteId: text("site_id").notNull(),
  /** phone_path | people | keys | handover | hours | quirk */
  topic: text("topic").notNull(),
  /** Which ladder rung a phone_path reaches (site_desk | stock_control | branch_manager). */
  rung: text("rung"),
  note: text("note").notNull(),
  /** The site's own words, in the language they were said. Null for code-observed notes. */
  quote: text("quote"),
  language: text("language"),
  level: text("level").notNull(),
  sourceCallId: text("source_call_id").notNull(),
  orderId: text("order_id").notNull(),
  sourceAt: ts("source_at").notNull(),
  createdAt: ts("created_at").notNull(),
  editedBy: text("edited_by"),
  editedAt: ts("edited_at"),
})

// Scenario suite (scripts/eval-suite.ts, shown on /evals). Wall-clock times, not the sim clock.
export const ringEvalRuns = pgTable("ring_eval_runs", {
  id: text("id").primaryKey(),
  model: text("model").notNull(),
  status: text("status").notNull(), // running | done | failed
  note: text("note"),
  passed: integer("passed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  voided: integer("voided").notNull().default(0),
  startedAt: ts("started_at").notNull(),
  endedAt: ts("ended_at"),
})

export const ringEvalResults = pgTable("ring_eval_results", {
  id: text("id").primaryKey(),
  evalRunId: text("eval_run_id").notNull(),
  scenarioId: text("scenario_id").notNull(),
  title: text("title").notNull(),
  orderId: text("order_id").notNull(),
  verdict: text("verdict").notNull(), // pass | fail | void (the simulated side did not play its part)
  expected: text("expected").notNull(),
  actual: text("actual").notNull(),
  reasons: jsonb("reasons").notNull(), // string[]: what failed, in plain words
  checks: jsonb("checks").notNull(), // { label, ok, setup }[]
  ringRunIds: jsonb("ring_run_ids").notNull(),
  stopOutcome: text("stop_outcome"),
  durationMs: integer("duration_ms").notNull(),
  at: ts("at").notNull(),
})

/** One model call inside a run (Ringo's turns, and the site/driver simulators' replies). Engineering
 *  trace only (/engine): never shown in the ops pages. Wall clock, not sim clock. */
export const ringTurns = pgTable("ring_turns", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  /** "ringo_turn", "short_reply" (site or driver simulator). */
  name: text("name").notNull(),
  model: text("model").notNull(),
  startedAt: ts("started_at").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  stopReason: text("stop_reason"),
  toolUses: integer("tool_uses"),
  error: text("error"),
})
