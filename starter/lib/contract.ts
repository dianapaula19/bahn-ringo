// Ringo contract: every shape that crosses the line between Lane UI and Lane AGENT.
// Owned by the tech lead. Lanes import from here and never edit it; ask the
// integrator for a change. See ../../CONTRACT.md for the rules behind each type.
// Pure types only: safe to import from client components.

// ---------------------------------------------------------------- basics

/** ISO 8601 UTC instant. Agent-side times are on the sim clock (see `now` in responses). */
export type Iso = string

/** A pointer to a source row. `table` is a dataset collection name or a ring_* table. */
export type SourceRef = { table: string; id: string }

export type Desk =
  | "ops-support" | "ops-readiness" | "ops-planning" | "ops-dispatch" | "ops-import"
  | "ops-travel" | "ops-shift" | "ops-intake" | "ops-evidence" | "ops-finance" | "ops-expenses"

// ---------------------------------------------------------------- evidence ladder

/** One vocabulary for the whole app. A quote is not a booking; a booking is not a movement. */
export type EvidenceLevel =
  | "claimed"   // someone said it, no direct check (customer note, driver report, generic site profile)
  | "quoted"    // the counterparty stated it about this car/booking directly, or a price/capacity quote; time-bound
  | "reserved"  // a booking/assignment/selected slot record exists
  | "observed"  // a physical signal: tracking, scan, pickup/delivery event, submitted photo
  | "verified"  // approved proof, document.verified, gate event, or a person's recorded check. Never set by the agent.
  | "stale"     // was true-ish, now too old or overtaken by a later fact on the same subject
  | "refuted"   // a later source contradicts it

export type SourceKind =
  | "message" | "order_note" | "endpoint_detail" | "endpoint_claim" | "site_profile" | "alert" | "incident"
  | "work_item" | "time_window" | "work_assignment" | "travel_option" | "travel_reservation" | "tracking"
  | "ferry_gate" | "proof" | "document" | "event" | "agent_proposal"
  | "ring_call" | "ring_driver_message" | "ring_event"

export type Fact = {
  id: string
  orderId: string
  /** Stable key so facts about the same thing line up, e.g. "pickup.key_holder", "pickup.access_route". */
  subject: string
  /** One plain sentence, no hedging words: the level carries the certainty. */
  claim: string
  level: EvidenceLevel
  sourceKind: SourceKind
  /** Must exist: a dataset row id or a ring_* row id. Facts without a valid source are dropped. */
  sourceId: string
  /** When the source said/recorded it (not when we read it). */
  at: Iso
  /** Who said it, for the chip: "Velantora Helsinki (site call)", "Customer", "Driver Yara Sivellin". */
  by: string
  origin: "dataset" | "ring"
  /** Set when a later fact made this one stale or refuted. */
  supersededByFactId: string | null
  note: string | null
}

// ---------------------------------------------------------------- triage

export type QueueBucket = "needs_you" | "ring" | "waiting" | "quiet"

export type TriageReason =
  | "SAFETY"               // critical alert or open vehicle incident
  | "FAILED_ACTION"        // a proposal or provider action failed / outcome unknown: reconcile, never retry blind
  | "AUTHORITY_BLOCKED"    // release authority or seller hold missing; only the customer/seller can clear it
  | "DECISION_WAITING"     // a Ringo proposal awaits review, or Ringo stopped with needs_person
  | "RECORDED_PROPOSAL"    // a dataset agent_proposal is PENDING_REVIEW
  | "DRIVER_WAITING"       // driver on site / empty pickup / driver asked a question nobody answered
  | "CUSTOMER_CONTACT"     // the next step is contacting the customer, which only a person may do
  | "DUE_SOON"             // owned work due within 60 min of now that Ringo cannot do
  | "RING_CAN_CALL"        // readiness gap Ringo can work by phone (bucket "ring")
  | "RING_WORKING"         // Ringo run in progress or callback scheduled (bucket "ring")
  | "WAITING_EXTERNAL"     // owned and waiting on a site/customer/driver reply (bucket "waiting")
  | "QUIET"

export type Triage = {
  orderId: string
  reference: string
  bucket: QueueBucket
  reason: TriageReason
  /** One sentence a shift lead understands: "Seller hold: customer must clear it before any driver goes." */
  why: string
  /** Rank inside the bucket; lower first. */
  rank: number
  severity: "critical" | "high" | "medium" | "low"
  decideBy: Iso | null
  ownerDesk: Desk | null
  /** The records that produced this result. Never empty unless bucket is "quiet". */
  sources: SourceRef[]
  /** Facts shown on the card, max 3, strongest first. */
  chips: Fact[]
  /** Overtaken signals shown struck through, e.g. 322's 05:16 TRACKING_GAP "overtaken by 08:07". */
  overtaken: { ref: SourceRef; label: string; overtakenBy: SourceRef; overtakenAt: Iso }[]
  /** Present when a person needs to act. For non-agent cards (322) triage writes it deterministically. */
  oneDecision: string | null
  pendingProposalIds: string[]
}

export type QueueItem = Triage & {
  vehicle: string          // "Bentley Continental GT"
  customer: string
  route: string            // "Munich → Hamburg"
  lane: string             // starter display_lane, for a small label only
}

/** GET /api/agent/queue */
export type QueueResponse = {
  now: Iso
  snapshotAt: Iso
  needsYou: QueueItem[]
  ring: QueueItem[]
  waiting: QueueItem[]
  quietCount: number
  total: number
}

// ---------------------------------------------------------------- phone (Seller-Sim)

export type IvrNodeKind = "menu" | "hold" | "human" | "voicemail" | "closed" | "dropped"

export type IvrOption = { digit: string; label: string; next: string }

export type IvrNode = {
  id: string
  kind: IvrNodeKind
  /** What the caller hears. For "hold": a description like "hold music, recorded message every 30 s". */
  prompt: string
  language: "en" | "de" | "fi" | "da"
  options?: IvrOption[]
  /** "hold": seconds before the next node; "menu": seconds before the menu repeats. */
  seconds?: number
  next?: string
  /** "human": which persona answers. */
  personaId?: string
}

/** Simulated phone tree for one site. Fictional, labelled SIMULATED in the UI. */
export type IvrTree = {
  siteId: string
  /** Never a real number. Format "sim:<siteId>". */
  number: string
  timezone: string
  openingHours: Record<string, string | null>
  root: string
  /** Shown when called outside opening hours. */
  closedNode: string
  nodes: Record<string, IvrNode>
}

/** Hidden script the Seller-Sim LLM plays. Never shown to the agent. */
export type SimPersona = {
  id: string
  siteId: string
  name: string            // fictional, e.g. "Ilona Alderbrook"
  role: string            // "stock control"
  language: "en" | "de" | "fi" | "da"
  knows: string[]         // what this person can truthfully say
  doesNotKnow: string[]   // what they must answer "I can't confirm that" to
  style: string
}

export type SimScenario = {
  orderId: string
  ivr: IvrTree
  personas: SimPersona[]
  /** Deterministic twists, e.g. first call drops during transfer (outcome DROPPED_UNKNOWN). */
  script: { attempt: number; atNode: string; event: "drop" | "voicemail" | "long_hold" }[]
  driver?: { driverId: string; persona: string; knows: string[] }
}

export type CallSpeaker = "ivr" | "ring" | "site" | "system"

export type CallTurn = {
  at: Iso
  speaker: CallSpeaker
  text: string
  /** Digits Ringo pressed, when speaker is "ring". */
  dtmf?: string
  /** What Ringo classified the line as when this turn arrived. */
  heard?: IvrNodeKind
  nodeId?: string
}

export type CallOutcome = "ANSWERED" | "NO_ANSWER" | "VOICEMAIL" | "CLOSED" | "DROPPED_UNKNOWN"

export type CallRecord = {
  id: string
  runId: string
  orderId: string
  siteId: string
  number: string
  purpose: string
  status: "live" | "ended"
  outcome: CallOutcome | null
  ivrPath: string[]
  transcript: CallTurn[]
  startedAt: Iso
  endedAt: Iso | null
  /** Set when this call was placed after an unknown-outcome call: what Ringo re-read and found first. */
  reconciledFrom: { callId: string; finding: string } | null
  simulated: true
}

// ---------------------------------------------------------------- driver (Driver-Sim)

export type DriverMessage = {
  id: string
  runId: string | null
  orderId: string
  driverId: string
  direction: "out" | "in"
  /** "question" needs no approval; "instruction" changes what the driver does and goes through a proposal. */
  intent: "question" | "instruction" | "reply"
  body: string
  at: Iso
  proposalId: string | null
  simulated: true
}

// ---------------------------------------------------------------- proposals, gate, trust

export type ActionType =
  | "call.site"               // auto: asking is free
  | "driver.ask"              // auto: asking is free
  | "driver.instruct"         // ask, promotable
  | "endpoint.record_contact" // ask, promotable
  | "endpoint.record_access"  // ask, promotable
  | "pickup.hold"             // ask, promotable
  | "address.update"          // ask, locked (customer input)
  | "slot.change"             // ask, locked (date)
  | "booking.change"          // ask, locked (booking)
  | "cost.approve"            // ask, locked (cost)
  | "customer.message"        // ask, locked; a person sends it
  | "diagnosis"               // never: no mechanical advice
  | "attribution"             // never: no blame from photos
  | "booking.cancel"          // never: prepare backups, cancel nothing

export type TrustMode = "auto" | "ask" | "never"

export type TrustRow = {
  actionType: ActionType
  mode: TrustMode
  /** Locked rows cannot be promoted: bookings, dates, costs, customer messages, and every "never". */
  locked: boolean
  lockedReason: string | null
  approvedUnchanged: number
  edited: number
  rejected: number
  /** Promotion to auto is offered when approvedUnchanged >= 5 and the last 5 reviews were unchanged approvals. */
  promotable: boolean
  updatedAt: Iso
}

/** GET /api/agent/trust */
export type TrustLedger = { now: Iso; rows: TrustRow[] }

/** POST /api/agent/trust */
export type TrustUpdateRequest = { actionType: ActionType; mode: TrustMode; operatorId: Desk; note: string }
export type TrustUpdateResponse = { row: TrustRow } | { error: string; code: "LOCKED" | "NOT_PROMOTABLE" }

export type CaseLawRule = {
  id: string                 // "CL-01"
  title: string              // "No mechanical advice"
  /** Dataset agent_proposals ids whose review notes this rule was written from. */
  learnedFrom: string[]
  /** "block" stops the proposal; "condition" lets it through with a note the reviewer sees. */
  effect: "block" | "condition"
  text: string
}

export type GateFinding = { ruleId: string; effect: "block" | "condition"; message: string; learnedFrom: string[] }

export type GateResult = {
  passed: boolean
  findings: GateFinding[]
  checkedAt: Iso
}

export type ProposalStatus =
  | "PENDING_REVIEW" | "APPROVED_AWAITING_EXECUTION" | "EXECUTED" | "REJECTED" | "FAILED" | "SUPERSEDED"

export type ReviewDecision = "APPROVED" | "EDITED" | "REJECTED"

export type Review = {
  decision: ReviewDecision
  decisionNote: string | null
  finalPayload: Record<string, unknown>
  reviewerId: Desk
  reviewedAt: Iso
}

export type Execution = {
  attemptedAt: Iso
  /** STALE = the basis changed since the proposal was written; nothing was changed, Ringo must re-read. */
  status: "SUCCEEDED" | "FAILED" | "STALE"
  error: string | null
  effectEventIds: string[]
}

/** Mirrors dataset agent_proposals (camelCased) plus Ringo extras. */
export type Proposal = {
  id: string
  origin: "dataset" | "ring"
  orderId: string
  proposedByAgentId: string            // "ring" for ours; dataset ids for recorded ones
  command: string                      // dotted, e.g. "endpoint.record_contact"
  actionType: ActionType | null        // null on dataset proposals
  targetType: string
  targetId: string
  alertId: string | null
  proposedPayload: Record<string, unknown>
  rationale: string
  summary: string
  evidenceRefs: SourceRef[]
  dependency: { basisEventId: string; checkedAt: Iso; executionPolicy: "RECHECK_CURRENT_STATE_BEFORE_WRITE" }
  status: ProposalStatus
  review: Review | null
  execution: Execution | null
  supersededByProposalId: string | null
  createdAt: Iso
  /** Ringo: what happens after approve, in one sentence the reviewer reads before clicking. */
  onApprove: string | null
  /** Ringo: what happens after reject. */
  onReject: string | null
  gate: GateResult | null
  trustMode: TrustMode | null
  runId: string | null
}

/** POST /api/agent/proposals/:id/review. `note` is required for EDITED and REJECTED. */
export type ReviewRequest = {
  decision: ReviewDecision
  note: string | null
  /** Required for EDITED; ignored otherwise. */
  finalPayload?: Record<string, unknown>
  reviewerId: Desk
}

export type ReviewResponse =
  | { proposal: Proposal; execution: Execution | null; next: string; triage: Triage }
  | { error: string; code: "NOT_FOUND" | "NOT_PENDING" | "NOTE_REQUIRED" | "PAYLOAD_REQUIRED" | "GATE_BLOCKED" | "READ_ONLY" }

// ---------------------------------------------------------------- agent runs

export type RunTrigger = "operator" | "triage" | "callback" | "eval" | "replay"

export type RunOutcome = "proposal_ready" | "needs_person" | "waiting" | "done" | "failed"

export type StopDecision = {
  outcome: RunOutcome
  /** ≤ 120 chars, the card headline. */
  headline: string
  /** The single decision for a person, or null when nothing is needed. */
  oneDecision: string | null
  options: { label: string; proposalId: string | null }[]
  /** Fact ids that support the headline. */
  found: string[]
  /** Short past-tense lines: "Called Velantora Helsinki stock control (2 min)". */
  did: string[]
  /** What happens after the person decides, or what Ringo will do next by itself. */
  whatNext: string
  nextCheckAt: Iso | null
  ownerDesk: Desk | null
}

export type RunSummary = {
  id: string
  orderId: string
  trigger: RunTrigger
  status: "running" | "stopped" | "failed"
  startedAt: Iso
  endedAt: Iso | null
  model: string
  decision: StopDecision | null
  error: string | null
  operatorMessage: string | null
}

export type ToolName =
  | "read_order" | "read_messages" | "read_docs" | "record_fact" | "place_call" | "call_input"
  | "send_driver_message" | "propose_action" | "schedule_callback" | "stop_with_decision"

/** One line of the NDJSON stream from POST /api/agent/orders/:id/run, and one ring_steps row. */
export type RunEvent =
  | { type: "run_started"; runId: string; orderId: string; trigger: RunTrigger; at: Iso; model: string; replay: boolean }
  | { type: "progress"; text: string; at: Iso }
  | { type: "tool_call"; stepId: string; tool: ToolName; input: Record<string, unknown>; at: Iso }
  | { type: "tool_result"; stepId: string; tool: ToolName; ok: boolean; summary: string; at: Iso }
  | { type: "call_turn"; callId: string; turn: CallTurn }
  | { type: "call_ended"; call: CallRecord }
  | { type: "driver_message"; message: DriverMessage }
  | { type: "fact"; fact: Fact }
  | { type: "gate"; command: string; result: GateResult }
  | { type: "proposal"; proposal: Proposal }
  | { type: "callback_scheduled"; job: CallbackJob }
  | { type: "stop"; decision: StopDecision; at: Iso }
  | { type: "error"; message: string; retryable: boolean; at: Iso }
  | { type: "run_ended"; runId: string; status: RunSummary["status"]; at: Iso }

/** POST /api/agent/orders/:id/run → 200 application/x-ndjson stream of RunEvent. */
export type RunRequest = {
  trigger: "operator" | "replay"
  /** What the person typed to Ringo ("call stock control again", "don't call before 10:00"). */
  message?: string
  operatorId?: Desk
}

/** GET /api/agent/runs/:runId */
export type RunDetail = { run: RunSummary; events: RunEvent[] }

export type CallbackJob = {
  id: string
  orderId: string
  dueAt: Iso
  reason: string
  status: "scheduled" | "done" | "cancelled"
  createdByRunId: string
  firedRunId: string | null
}

// ---------------------------------------------------------------- order story

export type StoryEntry = {
  at: Iso
  /** Who acted, in words: "Customer", "Velantora Helsinki", "Ringo", "Shift lead". */
  actor: string
  actorKind: "customer" | "site" | "driver" | "operator" | "agent" | "ring" | "system"
  text: string
  ref: SourceRef
  /** Facts this entry created or changed. */
  factIds: string[]
  channel: string | null
  simulated: boolean
}

/** GET /api/agent/orders/:id/story. The UI uses the starter's /api/orders/:id for car, route, tiles. */
export type OrderStory = {
  now: Iso
  orderId: string
  reference: string
  triage: Triage
  facts: Fact[]
  /** Newest last. Dataset messages, events, alerts plus Ringo calls, driver messages, reviews. */
  timeline: StoryEntry[]
  proposals: Proposal[]
  runs: RunSummary[]
  calls: CallRecord[]
  driverMessages: DriverMessage[]
  callbacks: CallbackJob[]
  /** Latest stop decision, the "one decision" panel. */
  decision: StopDecision | null
  /** Ringo can be run on this order (pickup readiness scope and not a "never" case). */
  ringEligible: boolean
  ringIneligibleReason: string | null
}

// ---------------------------------------------------------------- handover

export type HandoverSentence = {
  text: string
  /** At least one; the validator drops any sentence whose ids do not all exist. */
  sourceIds: SourceRef[]
  orderId: string | null
}

/** GET /api/agent/handover?since=ISO[&format=text] */
export type Handover = {
  now: Iso
  since: Iso
  sentences: HandoverSentence[]
  /** How many drafted sentences the validator dropped for missing/invalid ids. Shown, not hidden. */
  dropped: number
  writer: "scribe" | "template"
}

// ---------------------------------------------------------------- jobs, reset, eval

/** POST /api/agent/jobs/run-due → which callbacks fired. */
export type RunDueResponse = { now: Iso; fired: { jobId: string; runId: string; orderId: string }[] }

/** POST /api/agent/reset (demo only): wipes ring_* rows, restarts the sim clock at the snapshot. */
export type ResetResponse = { now: Iso; cleared: Record<string, number> }

export type EvalCase = {
  proposalId: string
  orderRef: string
  humanDecision: ReviewDecision | "FAILED"
  humanNote: string
  /** What the reviewer changed or objected to, as rule ids we expect to fire; empty = expect a pass. */
  expected: string[]
  /** Rules fired with every rule learned only from this proposal removed (leave-one-out). */
  fired: string[]
  hit: boolean
}

export type EvalReport = {
  ranAt: Iso
  mode: "leave_one_out" | "all_rules"
  cases: EvalCase[]
  caught: number        // flagged cases the gate flagged
  flagged: number       // cases a human flagged
  falseAlarms: number   // human approved unchanged, gate blocked
  passed: number
}

export type ApiError = { error: string; code?: string }
