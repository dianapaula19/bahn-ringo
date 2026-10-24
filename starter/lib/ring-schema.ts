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
