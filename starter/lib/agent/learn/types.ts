// Shapes for "Ringo learns from your edits". Pure types: safe to import from client components.
// Kept out of lib/contract.ts (integrator-owned); the review response carries `suggestion` as an extra field.
import type { ActionType, Desk, Iso, ReviewResponse } from "@/lib/contract"

export type LearnedStatus = "suggested" | "active" | "off" | "dismissed"

/** The deterministic check a learned rule runs in the Reviewer gate. */
export type LearnedSpec = {
  actionType: ActionType
  /** The payload field the corrections changed; null = the whole action (learned from rejections). */
  field: string | null
  /** The field must contain this phrase (word match, case and punctuation ignored). */
  require: string | null
  /** The field must not contain this phrase. */
  forbid: string | null
  /** The field, when present, must equal this value (booleans, numbers, lists). */
  equals?: unknown
  /** Only on orders that have all of these open (alert signals, work item kinds). Empty = every order. */
  situation: string[]
}

/** One review a rule cites. */
export type Citation = {
  correctionId: string
  proposalId: string
  orderId: string
  orderRef: string
  decision: "EDITED" | "REJECTED"
  field: string | null
  before: unknown
  after: unknown
  note: string
  reviewerId: string
  at: Iso
}

export type LearnedVersion = { version: number; status: LearnedStatus; text: string; at: Iso; by: string }

export type LearnedRule = {
  id: string
  /** CL-L01… once accepted; null while it is only a suggestion. */
  ruleId: string | null
  status: LearnedStatus
  version: number
  actionType: ActionType
  spec: LearnedSpec
  title: string
  /** The rule as the gate and the ledger state it. A person may reword it. */
  text: string
  /** Ringo's question, first person. */
  ask: string
  /** Review ids (proposal ids) the rule was learned from. */
  learnedFrom: string[]
  citations: Citation[]
  history: LearnedVersion[]
  createdAt: Iso
  updatedAt: Iso
}

/** GET /api/agent/learned */
export type LearnedResponse = { now: Iso; rules: LearnedRule[] }

/** POST /api/agent/learned/:id */
export type LearnedDecision = { action: "accept" | "dismiss" | "off" | "on" | "edit"; text?: string; operatorId: Desk }
export type LearnedDecisionResponse = { now: Iso; rule: LearnedRule } | { error: string; code: "NOT_FOUND" | "BAD_STATE" | "TEXT_REQUIRED" }

/** The review route's answer plus the rule Ringo now suggests, if this review completed a pattern. */
export type ReviewWithSuggestion = ReviewResponse & { suggestion?: LearnedRule | null }
