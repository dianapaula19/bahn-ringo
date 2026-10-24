# Ring build contract

Both lanes build to this file. Types live in `starter/lib/contract.ts`, which is the source of truth for every JSON shape below. If this file and `contract.ts` disagree, `contract.ts` wins; tell the integrator. All paths below are relative to `starter/` unless they start with `../`.

Ring is the control room's pickup readiness agent. It reads the order, rings the pickup site through a phone menu, can message the assigned driver, writes down what it learned as graded facts, and then either finishes or brings a person one decision.

## 0. Ground rules for both lanes

- Read `../CLAUDE.md` (hard rules) first. Next.js 16 is not the version you know, so check `node_modules/next/dist/docs/` before you use an API.
- Node 24: `export PATH=~/.local/node-v24.22.1-linux-x64/bin:$PATH`. The DB is already running and seeded on `localhost:5438`. Use `docker-compose` (v1, no `--wait`).
- Do not commit or push. The integrator commits.
- One new dependency is allowed: `@anthropic-ai/sdk` (Lane AGENT only). Anything else needs the integrator's OK.
- Never edit `lib/contract.ts`. If you need a change, stop and say so in your final report.
- Do not edit starter files you do not own (see §9). Lane UI may *call* `lib/present/*` freely.

## 1. Sim clock

The dataset is frozen at `2026-10-21T09:00:00Z` (a Wednesday). Ring's world starts there.

- `simNow() = SNAPSHOT + (Date.now() - epoch) * RING_CLOCK_SPEED`. `epoch` is stored in `ring_meta` on first use and reset by `POST /api/agent/reset`. `RING_CLOCK_SPEED` defaults to 1.
- Every ring row and every `RunEvent.at` uses `simNow()`. Every API response carries `now`, and the UI shows relative times against `now`, never against the browser clock.

## 2. New tables (Lane AGENT, `lib/ring-schema.ts`)

These are Drizzle `pgTable`s. There are **no foreign keys to starter tables**, because the starter's reseed TRUNCATEs its own tables and would fail. Order ids are plain `text`. Ids are prefixed text (`run-`, `call-`, `dm-`, `fact-`, `prop-`, `revt-`, `job-`) made with `crypto.randomUUID()`.

`drizzle.config.ts` changes to `schema: ["./lib/schema.ts", "./lib/ring-schema.ts"]`. Lane AGENT makes that one-line edit. Without it, `db:push` would offer to drop the ring tables.

| table | columns (all timestamps `timestamptz`) | maps to |
|---|---|---|
| `ring_meta` | `key text pk`, `value jsonb` | clock epoch, misc |
| `ring_runs` | `id pk`, `order_id`, `trigger`, `status`, `model`, `operator_message text null`, `decision jsonb null`, `error text null`, `started_at`, `ended_at null` | `RunSummary` |
| `ring_steps` | `run_id`, `seq int`, `event jsonb`, pk(`run_id`,`seq`) | `RunEvent` (the stream, persisted line by line) |
| `ring_calls` | `id pk`, `run_id`, `order_id`, `site_id`, `number`, `purpose`, `status`, `outcome null`, `ivr_path jsonb`, `transcript jsonb`, `reconciled_from jsonb null`, `started_at`, `ended_at null` | `CallRecord` |
| `ring_driver_messages` | `id pk`, `run_id null`, `order_id`, `driver_id`, `direction`, `intent`, `body`, `proposal_id null`, `at` | `DriverMessage` |
| `ring_facts` | `id pk`, `order_id`, `run_id null`, `subject`, `claim`, `level`, `source_kind`, `source_id`, `by`, `at`, `superseded_by_fact_id null`, `note null` | `Fact` (origin `ring`) |
| `ring_proposals` | `id pk`, `order_id`, `run_id`, `command`, `action_type`, `target_type`, `target_id`, `alert_id null`, `proposed_payload jsonb`, `rationale`, `summary`, `evidence_refs jsonb`, `dependency jsonb`, `status`, `review jsonb null`, `execution jsonb null`, `superseded_by_proposal_id null`, `on_approve`, `on_reject`, `gate jsonb`, `trust_mode`, `created_at` | `Proposal` (origin `ring`) |
| `ring_events` | `id pk`, `order_id`, `at`, `command`, `actor_type`, `actor_id`, `proposal_id null`, `changes jsonb`, `source_refs jsonb` | simulated committed changes (the effect events) |
| `ring_trust` | `action_type pk`, `mode`, `locked bool`, `locked_reason null`, `updated_at`, `updated_by` | `TrustRow` (the counts are computed from `ring_proposals.review`) |
| `ring_jobs` | `id pk`, `order_id`, `due_at`, `reason`, `status`, `created_by_run_id`, `fired_run_id null` | `CallbackJob` |

Dataset proposals (`agent_proposals` in `related_records`) are read-only. They appear as `Proposal` with `origin: "dataset"` and a gate verdict, but they cannot be reviewed (`READ_ONLY`).

## 3. Evidence ladder

`Fact = {id, orderId, subject, claim, level, sourceKind, sourceId, at, by, origin, supersededByFactId, note}`

Levels: `claimed → quoted → reserved → observed → verified`, plus `stale` and `refuted`. These rules are enforced in code (`lib/agent/facts.ts`), not in the prompt:

| source | highest level allowed |
|---|---|
| customer message, order note, driver message without a photo, `MANAGED_SITE_PROFILE` endpoint detail | `claimed` |
| site call or site message about this car, `SITE_CONTACT` endpoint detail, `travel_options` | `quoted` |
| `travel_reservations`, booked `work_assignments`, selected `time_windows` | `reserved` |
| `tracking_observations`, pickup/delivery events, submitted proof photo | `observed` |
| `APPROVED` proof, `document.verified` event, `ferry_terminal_events` | `verified` (Ring may never write this) |

- A fact becomes `refuted` only when a later source contradicts it. Ring records the new fact and sets `supersededByFactId` on the old one, citing both sources.
- A fact becomes `stale` when it is overtaken by a later fact on the same `subject`, or when it ages past its window: quotes after 2 h, tracking after 60 min.
- `sourceId` must resolve to a dataset row or a ring row. If it doesn't, `record_fact` returns an error and nothing is stored. This is the citation sanitizer.
- `lib/triage/facts.ts` derives `origin: "dataset"` facts from structured rows only: endpoint details and claims, the selected slot, the assignment, travel options and reservations, the latest tracking, proofs, release documents, and alerts. Facts taken from message text come only from Ring's `record_fact`.

## 4. Triage: who needs a person (Lane AGENT, `lib/triage/triage.ts`)

Triage is deterministic code with no LLM. It runs on the starter `Bundle` (`loadBoardBundles()`) plus ring rows. The first matching rule wins:

| # | reason | bucket | rule (sources go into `Triage.sources`) |
|---|---|---|---|
| 1 | `SAFETY` | needs_you | an alert with severity `critical` and status OPEN or ACKNOWLEDGED, or an open incident of kind `VEHICLE_WARNING` |
| 2 | `FAILED_ACTION` | needs_you | a proposal is `FAILED`, an execution is `STALE`, or a Ring call ended `DROPPED_UNKNOWN` with no reconciling call after it |
| 3 | `AUTHORITY_BLOCKED` | needs_you | an OPEN `RELEASE_DOCUMENT_UNCLEAR` alert, or an open work item `COMMERCIAL_RELEASE_HOLD` |
| 4 | `DECISION_WAITING` | needs_you | a Ring proposal is `PENDING_REVIEW`, or the latest Ring run stopped with `needs_person` |
| 5 | `DRIVER_WAITING` | needs_you | an open `EMPTY_PICKUP` incident, or an unanswered driver message in the last 2 h that asks something (a question or "please"); the row quotes it |
| 6 | `RECORDED_PROPOSAL` | needs_you | a dataset proposal is `PENDING_REVIEW` |
| 7 | `CUSTOMER_CONTACT` | needs_you | the open work item's `next_action` or a pending proposal needs the customer (`IDENTITY_INPUT_REQUIRED`, or a payload `contact` that includes `"customer"`) |
| 8 | `DUE_SOON` | needs_you | an open work item is due within 60 min of `now` and is not Ring-workable, or an OPEN (not acknowledged) `high` alert other than `SITE_ACCESS_UNCONFIRMED` |
| 9 | `RING_WORKING` | ring | a Ring run is in progress, or a callback is scheduled |
| 10 | `RING_CAN_CALL` | ring | an open work item of kind `PICKUP_CONTACT_HANDLE_REQUIRED`, `PICKUP_ACCESS_CHECK_REQUIRED` or `KEY_HOLDER_STOCK_CHECK`, or an OPEN `SITE_ACCESS_UNCONFIRMED` alert, on a `NEW` / `WAITING_FOR_PICKUP` order with a pickup site or contact |
| 11 | `WAITING_EXTERNAL` | waiting | an ACKNOWLEDGED alert with an owner, an open conversation with `waiting_on`, or any other open alert (so "quiet" really means no open alert) |
| 12 | `QUIET` | quiet | nothing above matched (the 70-ish quiet orders) |

- Ranking inside `needs_you` goes by reason order, then severity, then `decideBy` ascending. `decideBy` is the earliest open work item `due_at`; with no open task, the earliest of the selected pickup slot start (only before pickup) and the promise deadline.
- Overtaken signals: an OPEN `TRACKING_GAP` alert with a later alert, incident or driver message on the same assignment goes into `Triage.overtaken`. For 322, the 05:16 gap (`alert-x105238e92e7f3ba6`) is overtaken by the 08:07 SAFETY_STOP (`alert-x539dcfdd5a51d9ab`).
- The `oneDecision` for non-agent cards is a template filled from rows. For 322 it reads: "Driver says they are safe and stopped (driver 08:22). Location unverified, no photo yet. Customer: keep it stopped (08:40). Decide with the customer: roadside or tow." The times are message times in UTC.
- Self-check: `lib/triage/triage.check.ts`, which asserts the demo table in §8. Run it with `npx tsx lib/triage/triage.check.ts`.

## 5. The agent loop (Lane AGENT, `lib/agent/**`)

Invoke the `claude-api` skill before writing SDK code.

- **Client:** `@anthropic-ai/sdk`. The model comes from `process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5"`, with streaming via `client.messages.stream(...)` and `.finalMessage()`. Use a manual tool loop, because the gates run between turns. Tools use `strict: true` and `tool_choice: auto`; forced tool choice returns a 400 on this model. Do not send `temperature`. Use adaptive thinking at effort `medium`. The skill's default refusal fallback is fine on the Claude API.
- **Key:** `process.env.ANTHROPIC_API_KEY`, loaded from `starter/.env.local`. The integrator copies it there from `../../.env`, and it is gitignored. Never log it. If the key is empty, a run streams `{type:"error", message:"Ring is offline: no model key", retryable:false}`, and the UI offers **Replay**.
- **Replay:** `trigger:"replay"` streams `lib/agent/fixtures/<reference>.ndjson` (recorded `RunEvent`s) at a pace of 300 ms per event, with `replay:true` on `run_started`. `scripts/ring-record.ts` records a fixture from a real run.
- **Limits:** a run allows at most 24 tool calls, a call at most 14 `call_input`s, and a run at most 3 `propose_action` attempts (gate rejections included). When a limit is hit, the loop forces `stop_with_decision(outcome:"needs_person")` itself.
- **System prompt:** a frozen text (cache it) holding the hard rules, the ladder table, the tool order "read before you dial", and "stop when the next step needs a customer, money, a date or a booking". The order id and operator message go in the first user turn.

### Tools

| tool | input | returns | code-enforced guard |
|---|---|---|---|
| `read_order` | `{orderId}` | a compact order: status, active route, pickup/delivery endpoint details, selected slot, assignment + driver, open alerts, incidents, work items, recorded proposals, existing facts, triage. Every item carries its id | — |
| `read_messages` | `{orderId, sinceIso?}` | dataset messages (id, at, channel, author, recipient, language, body), plus Ring calls with outcome and transcript, plus Ring driver messages | — |
| `read_docs` | `{orderId}` | documents, proofs, attachment metadata, and the site profile rules (`release_document_rule`, `requires_signed_release`, hours, `advance_notice_minutes`, access notes) | — |
| `record_fact` | `{subject, claim, level, sourceKind, sourceId, at, by, supersedesFactId?, note?}` | `{fact}` or an error | the level cap from §3, `sourceId` must exist, `verified` is forbidden, and a refutation must cite a later source |
| `place_call` | `{orderId, siteId, purpose, reconciled?: {callId, finding}}` | `{callId, turn}`, the first IVR prompt | `read_order` **and** `read_messages` must already have run in this run. The site must be the order's **pickup** site or pickup contact, and never a customer or delivery recipient. If the last Ring call on this order was `DROPPED_UNKNOWN`/`NO_ANSWER`, `reconciled` is required. Outside the site's opening hours the call ends `CLOSED`. |
| `call_input` | `{callId, press?: string, say?: string, wait?: boolean, hangup?: boolean}` | `{turn, heard: IvrNodeKind, ended: boolean, outcome?}` | exactly one action per call. `say` passes through the gate's text rules (no mechanical advice, no promises) |
| `send_driver_message` | `{orderId, body, intent: "question"\|"instruction"}` | `{message, reply?}`. A question gets a Driver-Sim reply. An instruction is not sent and returns `{proposalId}` | only to the order's current assigned driver. An instruction becomes a `driver.instruct` proposal, and the trust ledger decides whether it is sent |
| `propose_action` | `{command, actionType, targetType, targetId, alertId?, payload, rationale, summary, evidenceRefs, onApprove, onReject}` | `{proposal}` or `{blocked: GateFinding[]}` | the gate runs first. `dependency.basisEventId` = the latest ring or dataset event id on the order. `trustMode` comes from `ring_trust`: `auto` executes immediately, `never` is refused |
| `schedule_callback` | `{orderId, dueAt, reason}` | `{job}` | `dueAt` must fall within the site's opening hours |
| `stop_with_decision` | `StopDecision` | ends the run | `found` must be fact ids from this order, `headline` is at most 120 chars, and when `outcome` is `proposal_ready` at least one pending proposal must exist |

Every tool result streams as `tool_result` with a human-readable `summary`, for example "Read 9 messages (latest: site call 08:24)". The UI shows summaries, never raw JSON.

### Seller-Sim and Driver-Sim (`lib/agent/sim/**`)

- `scenarios.ts` exports one `SimScenario` per demo order. The IVR is a deterministic `IvrTree` walked in code. Only `human` nodes call the model, which plays the `SimPersona` (effort `low`, at most 2 sentences, in the persona's language, answering only from `knows` and saying "I can't confirm that" for anything else).
- `script` twists are deterministic, for example 010's first attempt drops during the transfer, so its outcome is `DROPPED_UNKNOWN`.
- An order with no scenario gets a generic tree for its pickup site (main menu → "vehicle collections" → hold 40 s → voicemail). Ring cannot invent facts from it.
- Every sim output is `simulated: true`, and the UI labels it **Simulated call** / **Simulated driver**.
- Phone numbers are `sim:<siteId>`. People in sim personas use fictional names in the dataset's style, such as "Ilona Alderbrook".

## 6. Case-law Reviewer gate (`lib/agent/gate.ts`, `lib/agent/caselaw.ts`)

The gate is deterministic: predicates over `{command, actionType, payload, text fields}` plus the order bundle, with no LLM. The human signs off `caselaw.ts` by hand. The starting draft:

| id | effect | rule | learnedFrom |
|---|---|---|---|
| CL-01 | block | No mechanical advice: no restart/reset/diagnose/"drive on" wording, and no `authorize_restart`/`authorize_driving` true | `agent-x95169653143f1607` (322) |
| CL-02 | block | Never set a confirmation flag (`*_confirmed`, `*_verified`, `boarding_*`) true without a `verified`-level source in `evidenceRefs` | `agent-x40ab609877909161` (020) |
| CL-03 | block | No blame or liability (`attribution`, `*_CAUSED`, `assign_liability`) | `agent-xaa0af5ec9f775363` (055) |
| CL-04 | block | Never pick from an unrefreshed list (`use_first_available`, or an option whose `checked_at` is older than 2 h, unless `require_fresh_capacity_check`) | `agent-x3151927d69c76a10` (194) |
| CL-05 | condition | A backup is not a booking: no "booked"/"confirmed" wording about a replacement, and `cancel_current` must be false | `agent-xf4800bb1b907cf89` (449) |
| CL-06 | condition | Keep the customer promise until a booking is confirmed (`change_promise` must be false unless the action type is `slot.change`) | `agent-x4ac988b20000595f` (299), `agent-x68cbbd7e6e58691c` (154) |
| CL-07 | condition | A quote is not a purchase: a refresh or check returns for a separate booking decision | `agent-x68cbbd7e6e58691c` (154), `agent-x1c721af5508e707a` (603) |
| CL-08 | condition | A ticket is not a movement: after booking, still verify the prior duty and arrival | `agent-x44051005c0c18aaf` (089) |
| CL-09 | condition | Don't tell the customer something the records haven't established (`tell_customer_*` true without a source) | `agent-xf874ddfecf02bb68` (194) |
| CL-10 | block | The agent never contacts a customer. A `contact` that includes `"customer"`, or a customer-facing message not typed `customer.message`, is blocked | brief rule (no proposal) |
| CL-00 | — | Recheck before write. Enforced at execution, not by the gate: on approve, if the order has a newer event than `dependency.basisEventId`, the execution is `STALE` and nothing changes | all 14 |

**Eval** (`scripts/eval-reviewer.ts`, run with `npm run eval:reviewer -- [--all]`):
- It covers the 10 reviewed dataset proposals: 3 EDITED, 1 REJECTED, 1 FAILED (approved with a note), and 5 APPROVED with conditions.
- For each case, it drops every rule whose `learnedFrom` contains **only** that proposal (leave-one-out), runs the gate on the original `proposed_payload`, and compares the result with the human's review:
  - `hit` means every expected rule fired and no unexpected block fired.
  - The expected rules per case are the rows above.
- It prints an `EvalReport` table and writes `eval/gate-<timestamp>.json`.
- The 4 PENDING proposals are listed as "gate opinion, unscored". For example, it blocks 593's `contact: ["site","customer"]` with CL-10.
- Report the leave-one-out number **and** the misses in `../PROCESS.md`. A low honest number beats a high leaky one.

`scripts/eval-ring.ts` (needs the key) runs Ring on the demo orders and asserts the behaviour column in §8. It prints pass/fail for each assertion.

## 7. API routes (Lane AGENT, `app/api/agent/**`, `runtime = "nodejs"`)

Errors use `{error, code?}` with 400/404/409. Every success body carries `now`.

| method + path | request | response |
|---|---|---|
| `GET /api/agent/queue` | — | `QueueResponse` |
| `GET /api/agent/orders/:id/story` | — | `OrderStory` (404 `ApiError`) |
| `POST /api/agent/orders/:id/run` | `RunRequest` | `200 application/x-ndjson`, one `RunEvent` per line, ending with `run_ended`. 409 if a run is already live on the order |
| `GET /api/agent/runs/:runId` | — | `RunDetail` |
| `POST /api/agent/proposals/:id/review` | `ReviewRequest` | `ReviewResponse`. On APPROVED/EDITED it rechecks the basis, then executes: it writes `ring_events`, updates ring facts, and sends an approved driver message. Customer messages are recorded as "sent by <desk>" (simulated) |
| `GET /api/agent/trust` | — | `TrustLedger` |
| `POST /api/agent/trust` | `TrustUpdateRequest` | `TrustUpdateResponse`. 409 `LOCKED` / `NOT_PROMOTABLE` |
| `GET /api/agent/handover?since=ISO[&format=text]` | — | `Handover`, or `text/plain` with one sentence per line plus ids, for Telegram/cron. The default `since` is `snapshot - 3h` |
| `GET /api/agent/jobs` | — | `{now, jobs: CallbackJob[]}` |
| `POST /api/agent/jobs/run-due` | — | `RunDueResponse`. Cron, or the "Try now" button, calls it |
| `POST /api/agent/reset` | — | `ResetResponse`. Demo only |

The trust ledger starts like this. Rows marked locked (L) cannot be promoted:

- `call.site` auto, `driver.ask` auto
- `driver.instruct` ask, `endpoint.record_contact` ask, `endpoint.record_access` ask, `pickup.hold` ask
- `address.update` ask (L), `slot.change` ask (L), `booking.change` ask (L), `cost.approve` ask (L), `customer.message` ask (L)
- `diagnosis` never (L), `attribution` never (L), `booking.cancel` never (L)

`promotable` is true when `approvedUnchanged >= 5` and the last 5 reviews were all unchanged approvals.

**The handover Scribe** writes sentences from `ring_events`, ring runs, calls, reviews and dataset events/messages since `since`. Every sentence must carry `sourceIds`. The validator drops a sentence if any id does not resolve, and counts it in `dropped`. With no key, the template writer composes one sentence per event.

**Reading the stream in the UI:**
```ts
const res = await fetch(`/api/agent/orders/${id}/run`, { method: "POST", body: JSON.stringify(req) })
const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
let buf = ""
for (;;) { const { value, done } = await reader.read(); if (done) break
  buf += value; const lines = buf.split("\n"); buf = lines.pop()!
  for (const l of lines) if (l.trim()) onEvent(JSON.parse(l) as RunEvent) }
```

## 8. Demo orders (verified in `dataset/data` at the snapshot)

| ref (id) | state at snapshot (row ids) | expected triage | Ring behaviour (asserted by `eval-ring.ts`) |
|---|---|---|---|
| **CD-420516** (`ord-00516`), NEW / CONFIRMED, Velantora Helsinki `site-001`, selected slot Mon 26 Oct 07:00-10:00Z (Helsinki) | customer said "reception has the keys" (support_chat 19 Oct 10:44) and the note says "use the side gate" (`order_notes` 18 Oct); site call 21 Oct 08:24 `msg-x5d8006558b9e7cc6` refutes both; alert `alert-x9dd9663e6059eeba` SITE_ACCESS_UNCONFIRMED; work item `work-x2174da059fcd89e8` KEY_HOLDER_STOCK_CHECK due 09:15 | ring / `RING_CAN_CALL` | Reads first. Records "reception has keys" as `claimed`, then `refuted` by `msg-x5d8006558b9e7cc6`, **without re-asking reception**. Calls `site-001` IVR → collections/stock control (sim persona). Records the key holder plus an attended release at the collection bay as `quoted`. Proposes `endpoint.record_access` and stops `proposal_ready`. After approval, it leaves Needs you |
| **CD-420458** (`ord-00458`), NEW / PREPARING, Ferrari Roma, Calverona Hamburg `site-042` (`requires_signed_release: true`), DE/EN messages | site call 08:38 `msg-x577aebe6f59acb2d`: seller withdrew permission over an unpaid invoice, no signed release, "do not send a driver"; alert `alert-xad90176c4d6e6fc5` RELEASE_DOCUMENT_UNCLEAR high; work item `work-x034712fe38184350` COMMERCIAL_RELEASE_HOLD due 10:00 | needs_you / `AUTHORITY_BLOCKED` | Reads, then **does not call** (the site's statement is 22 min old and is a block). Proposes nothing to the customer. Stops `needs_person`: "Seller hold. Only the customer can clear it. You decide whether and how to contact them." Never dispatches |
| **CD-420593** (`ord-00593`), WAITING_FOR_PICKUP, BMW M4, `site-001`, driver `drv-139` Yara Sivellin on site since 07:00Z, slot ended 08:00Z | incident EMPTY_PICKUP INVESTIGATING; alert `alert-xd736bb2556e316a6` ACKNOWLEDGED (ops-shift); site 07:21 "similar stock reference"; customer 07:39 "do not substitute a different car"; driver 07:57 "can wait 30 more minutes"; recorded proposal `agent-x6ad46f8e74398f5e` PENDING | needs_you / `DRIVER_WAITING` | Asks the driver (auto, Driver-Sim) whether they are still on site. May call `site-001` stock to check the VIN (quoted: "not in our stock list"). Gate shows CL-10 on the recorded proposal. Proposes `driver.instruct` ("you can leave, travel plan follows"), which goes to ask. Stops `needs_person`: the customer must say which site holds the VIN, and a person contacts them |
| **CD-420010** (`ord-00010`), NEW / PREPARING, Kervalin Frankfurt `site-039` (German IVR) | endpoint `ep-x00908fdb1cc7b0d3`: pickup contact handle null, UNCONFIRMED; work item `work-xe5ffe78960670002` PICKUP_CONTACT_HANDLE_REQUIRED due 15:00 | ring / `RING_CAN_CALL` | The first call drops in transfer (`DROPPED_UNKNOWN`). Ring re-reads, schedules a callback, and the second call carries `reconciled`. The desk gives a direct contact and "order reference + driver ID at handover" (`quoted`). Proposes `endpoint.record_contact` |
| **CD-420023** (`ord-00023`), NEW / PREPARING, pickup `addr-00823` raw input "Berlin", no street, `site_id` null, contact handle `site-038@example.test` | endpoint `ep-x69bf3a9962438404` NEEDS_VERIFICATION, stated by CUSTOMER_ORDER_INPUT; work item `work-x63c3d7a51c26655e` PICKUP_ACCESS_CHECK_REQUIRED | ring / `RING_CAN_CALL` | Calls the pickup contact. The site states a street (`quoted`). Ring **does not change the address**: it proposes `address.update` (locked ask) with onApprove "a person confirms with the customer first", and stops `proposal_ready` |
| **CD-420322** (`ord-00322`), IN_TRANSIT, Bentley Continental GT, driver `drv-319` Kasper Kovelund | SAFETY_STOP `alert-x539dcfdd5a51d9ab` critical ACK; incident VEHICLE_WARNING, `recovery_decision` PENDING_CUSTOMER, location unverified; TRACKING_GAP `alert-x105238e92e7f3ba6` OPEN 05:16 (overtaken); driver 08:22 safe, engine off, photo offered not sent; customer 08:40 "keep it stopped"; work item `work-xbfed2fad876cbd13` due 09:15 | needs_you / `SAFETY` (first card) | **Not a Ring order** (`ringEligible:false`, "on-the-road safety: a person owns this"). It is a non-agent card with a deterministic `oneDecision` (§4) |

Also in the data, if you need more cases:
- `CD-420009` (`ord-00009`): no VIN or plate, so it lands in needs_you as `CUSTOMER_CONTACT`.
- `CD-420347`: site call says showroom vs yard. A good extra Ring case.
- `CD-420222`: contact gap linked only from the support inbox.

## 9. File ownership

| owner | paths |
|---|---|
| **Lane UI** | `app/**` pages, layouts and components, `app/globals.css`, `public/**`, and `app/_stubs/**` (its own fixtures built from `lib/contract.ts`). It may add view helpers under `lib/present/**` but may not change existing exports |
| **Lane AGENT** | `lib/agent/**`, `lib/triage/**`, `app/api/agent/**`, `lib/ring-schema.ts`, `scripts/eval*.ts`, `scripts/ring-*.ts`, `eval/**`, the one line in `drizzle.config.ts`, and `package.json` (the dependency plus `ring:*`/`eval:*` scripts) |
| **Tech lead / integrator** | `lib/contract.ts`, `../CLAUDE.md`, `../CONTRACT.md`, `../PROCESS.md`, `../README.md`, `.env*`, and git |
| nobody (read-only) | `lib/schema.ts`, `lib/db.ts`, `scripts/seed*.ts`, `scripts/smoke*.ts`, `../dataset/**`, `../attachments/**` |

**Lane UI notes:**
- Build against stubs until the routes land. Every stub must type-check as the contract type, for example `const q: QueueResponse = {...}`.
- Pages:
  - `/` is the queue: the "Since you left" strip, then Needs you, Ring is on it, Waiting on others, and "N quiet orders" folded.
  - `/orders/[id]` is the story. It shows the one-decision panel, fact chips with level + source + time, the timeline, Ring's live run (transcript first; a "Listen" button reads it with `speechSynthesis` and never autoplays), and Approve / Edit / Reject (reject needs a reason).
  - `/trust` is the ledger.
  - Move the old board to `/board`.
- Empty and loading states are required on every panel.

**Lane AGENT notes:**
- Every route must work with an empty `ring_*` (fresh clone).
- `npm run typecheck` must pass before you report back.
