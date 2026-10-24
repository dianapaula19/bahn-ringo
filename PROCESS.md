# How we built Ring

How we worked with coding agents: what we asked for, what we checked, what we threw away, and what the evals say. Times are Europe/Helsinki on Sat 24 Oct 2026 and are approximate (taken from file times).

## 1. How we worked with coding agents

- **One person, Claude Code sessions, five roles.** All work ran in Claude Code (Opus 5.5). The human set the goal, read every report and owns the case-law file (`starter/lib/agent/caselaw.ts`).
- **Tech lead (one session).** It read the brief, the dataset and the starter, then wrote `CLAUDE.md` (14 hard rules), `CONTRACT.md` (tables, tools, routes, demo orders, file ownership) and `starter/lib/contract.ts` (every shared type). No build lane started before the contract existed.
- **Three parallel build lanes**, each a separate session started by a workflow script, with strict file ownership (CONTRACT.md §9):
  - **Lane AGENT:** Ring's tool loop, the phone and driver simulators, triage, the Reviewer gate and its eval, proposals and trust, the handover, all `/api/agent/*` routes, the background runner.
  - **Lane UI:** the "Needs you" queue, the order story, the trust page, the "Since you left" strip. It built against its own typed stubs until the routes existed.
  - **Lane MATRIX:** studied the Matrix OS source and wrote the manifest, cron entry, box loop and a dry-run deploy script.
- **Integrator (one session).** It wired the UI to the real routes, deleted the stubs, ran every check, reviewed the product against the judging criteria, fixed what it found, wrote this file and the README, did a fresh-clone run and committed.
- Every lane had to finish with a written report: files touched, how to run, done, not done, and what it threw away. The integrator read the reports and then checked the claims itself instead of trusting them.

## 2. Prompts and lanes

| time | lane | what we asked for | result |
|---|---|---|---|
| 15:50 | lead | Read the packet and starter. Write the hard rules, the build contract and the shared types | `CLAUDE.md`, `CONTRACT.md`, `starter/lib/contract.ts` |
| 16:00 | AGENT | Build Lane AGENT to the contract: a real tool loop, Seller-Sim and Driver-Sim, read tools, triage, reconcile before retry, the case-law gate with a leave-one-out eval, proposals / approvals / trust with their APIs, the Scribe handover, a background runner without a cron library, a `node:test` self-check | 10 routes, 5 replay fixtures, 15/15 self-check, eval 3/10 leave-one-out, Ring eval 38/38 |
| 16:00 | UI | Build Lane UI to the contract: queue home, order story, trust ledger. Stubs until the routes exist. `npm run build` must pass | Queue, story, trust pages; headless-Chrome screenshots against stubs |
| 16:00 | MATRIX | Learn the real Matrix OS formats from its source. Write manifests, cron entries, a dry-run deploy and README text. Mark every unverified assumption | `matrix/` (manifest, cron, box loop, deploy.sh), assumptions A1 to A10 |
| 16:40 | integrator | Wire the UI to the real routes, run everything live, review against the judging criteria, fix the top issues, write README and PROCESS, fresh-clone run, commit | This commit series |

## 3. What we checked

**Against the data**
- Every demo order id and row id in CONTRACT.md §8 was checked against `dataset/data/*.jsonl` at the snapshot. One correction came from that: the briefing said "driver safe 08:11" on CD-420322, but the data says 08:22 (`driver_chat`), and the photo was offered, not sent.
- Lane AGENT dumped the 14 dataset `agent_proposals` and every demo order's rows before writing triage. It confirmed in the DB which collections live in `related_records`, and that the board bundles do not load messages, so triage loads them itself for the driver and customer rules.
- The 322 one-decision template was checked against the real message times (driver 08:22, customer 08:40).

**Against the Matrix OS source (not the research brief)**
- Lane MATRIX read the gateway's cron code. A Matrix cron job only sends its fixed `message` to a channel; it cannot run commands. The brief claimed "scheduled jobs are agent runs", which is false. So the 5-minute clock lives in our `box-loop.mjs`, and Matrix only delivers the Telegram text.
- Hand edits to `~/system/cron.json` do nothing until the gateway restarts (the store hands back a cached copy), so registration goes through `POST /api/cron`.
- `"database": "postgres"` in a manifest makes a node app fail to spawn (the resolver is never wired), so we dropped it.

**Tests and assertions that guard the behaviour**
- `npm run ring:check` (node:test, 15 tests): triage on the demo orders, gate rules, speech rules, and the evidence ladder. It exits non-zero on a broken assertion. An earlier `process.exit` workaround hid failures (exit 0 on a broken test); it was replaced by closing the DB pool.
- `npm run eval:ring`: Ring live on the five demo orders, with 38 assertions from CONTRACT §8 (read before dialling, no customer contact, never `verified`, 010's second call carries `reconciled`, 023 does not change the address, and so on).
- Every route was called over HTTP, including the error paths: reject without a note (`NOTE_REQUIRED`), promoting a locked row (`LOCKED`, 409), promoting without five clean approvals (`NOT_PROMOTABLE`, 409), a second run on a busy order (409), unknown order and run (404), and a `STALE` execution after a synthetic newer event.

**What the integrator found and fixed (things the lanes had reported as done)**
1. **Approving the second proposal from one run always failed.** Ring on 516 wrote two proposals (record access, record contact) on the same read. Approving the first wrote an event, so the second one's basis was now "old" and it went `STALE`, which put 516 back in Needs you as a failed action. Neither lane had tested approving two proposals in a row. Now sibling proposals from the same run that change a different kind of thing do not make each other stale; any other newer event still does.
2. **A one-hour DST error in the phone simulator.** The 516 site persona said the slot was 10:00 to 13:00 Helsinki time, but the slot is 07:00 to 10:00 UTC on Mon 26 Oct, after the clocks went back on 25 Oct, so it is 09:00 to 12:00 EET. The story page, which formats the slot from the row, showed 09:00 while Ring's quoted fact said 10:00. We fixed the persona and re-recorded the replay fixtures.
3. **"What Ring did" mixed the tools' record with the model's own account.** The list merged code-written lines with the model's `did` lines, which repeated each other and could claim things no tool did. It is now built only from what the tools actually did (calls, proposals, refutations, facts written).
4. **Facts showed who and when, but not which record.** Each fact now names its source record ("message", "Ring call", "slot record"), carries the source id on hover, and links to the timeline entry when the source is on the timeline.
5. **Raw codes and ISO strings on screen.** "Selected pickup slot 2026-10-26T07:00:00Z to …" and "PICKUP_PHOTOS proof is submitted" are now "Selected pickup slot: 26 Oct 09:00–12:00 EET" and "Pickup photos submitted".
6. **An overtaken signal still showed as a current fact.** On 322 the 05:16 tracking gap was struck through in the decision panel but listed as current under "What we know". It now folds into "no longer true or out of date".
7. **Long timelines.** 322 has 33 entries, with the ones that matter at the bottom. The timeline now shows the latest 10 and folds the rest behind "Show 23 earlier entries".
8. **Trust page.** Four disabled dark "Let Ring do it" buttons read as broken. The button now appears only when the row can be promoted; the row text already says what is missing.
9. **The Matrix box loop ran the background script without the shim**, so `server-only` would fail to resolve on the box. It now uses the same `--require ./scripts/ring-shim.cjs` as `npm run ring:background`.
10. **The UI stubs.** They are deleted (`app/_stubs/`, the "Sample data" banner). The UI talks only to the real routes; a route error shows as an error, not as made-up data.

## 4. What we threw away

**Planning**
- The starter's lane board as the home page. It moved to `/board`, and the queue replaced it.
- A separate "Ring Monitor" app. It is folded into the one ops app.
- ElevenLabs voices, and live voice as a requirement. The transcript comes first, with an opt-in browser `speechSynthesis` "Listen" button.
- The idea that "the 14 proposals contain 13 corrections". The real number of review signals is 10 (3 edited, 1 rejected, 1 failed, 5 approved with conditions).

**Lane AGENT: first answers we did not take**
1. **Strict tool schemas everywhere.** All-strict tools got a 400 ("compiled grammar is too large"). Strict stays on the 7 small tools; the 3 big ones (`record_fact`, `propose_action`, `stop_with_decision`) are validated in code.
2. **516, first run.** Ring stopped `needs_person` without calling stock control, which the site itself had named as the next step. On the second run it called, but refuted the customer's "reception has keys" without recording it first. The prompt was rewritten twice in general terms, not order-specific ones: calling the site is Ring's job, and a claim on record is recorded as `claimed` and then refuted from the later site statement.
3. **The ring-call evidence cap.** The first version allowed `quoted` only after hang-up, which rejected valid facts during a live call. It now depends on whether the site person has spoken.
4. **010 redial.** Ring redialled right after the dropped call. The guard allowed it because Ring had re-read, but the contract wants a callback, so the prompt now says to schedule one and stop as "waiting".
5. **023 address.** Ring tucked the street address into an `endpoint.record_access` proposal. A street address is customer input, so it must be a locked `address.update`.
6. **458.** Ring proposed a `pickup.hold` when it should propose nothing; it now stops `needs_person`.
7. **Stale-run detection** compared the real `Date.now()` with sim-clock timestamps, so every running run would have looked dead. It uses the sim clock now.
8. **A higher leave-one-out score.** Citing the brief or our own CLAUDE.md as the provenance of CL-01 to CL-05 would have lifted the score, but CLAUDE.md was written after reading the reviews, so that is leakage. We report the honest 3/10.

**Lane UI**
- The decision panel used a `tone-*` class that turned the whole panel's text teal or red; only the border is coloured now.
- "Decide 37 min ago" became a red "Overdue by 37 min". The reason text wraps to two lines instead of being cut at one.
- Paging (50 rows plus "Show more") instead of a virtualised list: enough for hundreds of orders, no new dependency.
- The `call_input` and `record_fact` tool calls are hidden in the live run; the call transcript box and the fact chips show the same thing without the noise.

**Lane MATRIX**
- Writing `~/system/cron.json` directly (the cache bug above), feeding the board through `readFile` or KV files (not in the bridge), opening sqlite directly (Velho's rules say `lib/db.ts` only), `console.assert` in self-checks (it does not fail the process), a vite runtime for a static board, and sending Telegram from our own code. Delivery goes through a one-shot Matrix cron job to the operator's own chat only.

## 5. Eval results

**Reviewer gate, leave-one-out** (`npm run eval:reviewer`): for each of the 10 reviewed dataset proposals, every rule learned only from that proposal is removed before it is scored. A case is a hit when every expected rule fires and no unexpected block fires.

| run | mode | caught / flagged | false alarms | cases hit | notes |
|---|---|---|---|---|---|
| 24 Oct 16:33 | all rules (leaky upper bound) | 10 / 10 | 0 | 10 / 10 | every rule sees its own source case |
| 24 Oct 16:36 | leave-one-out | 3 / 10 | 0 | 3 / 10 | only rules learned from two proposals survive |

Hits: CD-420299 (CL-06), CD-420154 (CL-07), CD-420603 (CL-07). CL-06 and CL-07 were each learned from two proposals, so they survive leaving one out.

Misses (leave-one-out), each because its rule was learned from that proposal alone:
- CD-420322, EDITED, expected CL-01 (no restart advice): nothing fired.
- CD-420020, EDITED, expected CL-02 (no confirmation flag without a verified source): nothing fired.
- CD-420194 rebook, EDITED, expected CL-04 (no pick from an unrefreshed list): only CL-06 fired.
- CD-420055, REJECTED, expected CL-03 (no blame): nothing fired.
- CD-420089, APPROVED, expected CL-08 (a ticket is not a movement): nothing fired.
- CD-420449, APPROVED, expected CL-05 (a backup is not a booking): nothing fired.
- CD-420194 billing, APPROVED, expected CL-09 (don't tell the customer what the records haven't established): nothing fired.

What this means: with one example per rule, the gate does not generalise to a case it has not seen. It is a memory of past reviews, and it gets better only as reviewers add cases.

Gate opinions on the 4 pending proposals (unscored):
- CD-420593 `pickup.verify_identity`: **blocked** by CL-10 (`contact: ["site","customer"]`; the agent would contact the customer).
- CD-420399 `assignment.review_positioning`: passes.
- CD-420299 `travel.verify_booking_outcome`: passes.
- CD-420055 `condition.compare_evidence`: passes.

**Ring behaviour** (`npm run eval:ring`, live model, `claude-sonnet-5-5`): **38 / 38** on the integrator's run (24 Oct 16:44). The first full run by Lane AGENT scored 35 / 38; the three misses led to prompt fixes 2, 4 and 6 above. The model's behaviour varies between runs, so this is one sample, not a guarantee.

| order | what is asserted | pass? |
|---|---|---|
| CD-420516 | reads before dialling; records "reception has keys" as claimed and refutes it from `msg-x5d8006558b9e7cc6` without re-asking reception; records a quoted fact from the call; proposes `endpoint.record_access`; stops `proposal_ready` | 9 / 9 |
| CD-420458 | does not call; proposes nothing; no customer contact; stops `needs_person` | 7 / 7 |
| CD-420593 | asks the driver; a driver instruction goes to a person; no customer contact | 7 / 7 |
| CD-420010 | first call `DROPPED_UNKNOWN`; schedules a callback; second call carries `reconciled`; proposes `endpoint.record_contact` | 8 / 8 |
| CD-420023 | does not change the address; proposes `address.update` (locked ask); stops `proposal_ready` | 7 / 7 |

Every order also asserts: the run finished, read before dial, no customer contact, never `verified`.

**End to end in the browser** (integrator, headless Chrome clicking "Run Ring"): 516 finished in 48 s with one proposal and a stop card; 023 in 35 s with two proposals and a stop card; Replay on 593 streamed the recorded run. Approving both 023 proposals (record access, then the address update) executed both and moved 023 to quiet. With a synthetic newer event on 516, approval still came back `STALE` and changed nothing.

## 6. Known gaps

- Nothing has run on a real Matrix OS box yet. The deploy script is a dry run until `--apply`, and assumptions A1 to A10 (Node 24 on the box, Docker, serving a Next app under `/apps/<slug>/`, and so on) are unverified.
- The gate's leave-one-out score is low (3/10) for the reason above.
- No speech input in the Ring chat box; earlier runs are not browsable (only the latest run's headline shows).
- Ring prepares no customer-message drafts. The background runner's `--autorun` is off by default so it cannot take over a live demo.
