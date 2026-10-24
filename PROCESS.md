# How we built Ringo

How we worked with coding agents: what we asked for, what we checked, what we threw away, and what the evals say. Times are Europe/Helsinki on Sat 24 Oct 2026 and are approximate (taken from file times).

## 1. How we worked with coding agents

- **One person, Claude Code sessions, five roles.** All work ran in Claude Code (Opus 5.5). The human set the goal, read every report and owns the case-law file (`starter/lib/agent/caselaw.ts`).
- **Tech lead (one session).** It read the brief, the dataset and the starter, then wrote `CLAUDE.md` (14 hard rules), `CONTRACT.md` (tables, tools, routes, demo orders, file ownership) and `starter/lib/contract.ts` (every shared type). No build lane started before the contract existed.
- **Three parallel build lanes**, each a separate session started by a workflow script, with strict file ownership (CONTRACT.md §9):
  - **Lane AGENT:** Ringo's tool loop, the phone and driver simulators, triage, the Reviewer gate and its eval, proposals and trust, the handover, all `/api/agent/*` routes, the background runner.
  - **Lane UI:** the "Needs you" queue, the order story, the trust page, the "Since you left" strip. It built against its own typed stubs until the routes existed.
  - **Lane MATRIX:** studied the Matrix OS source and wrote the manifest, cron entry, box loop and a dry-run deploy script.
- **Integrator (one session).** It wired the UI to the real routes, deleted the stubs, ran every check, reviewed the product against the judging criteria, fixed what it found, wrote this file and the README, did a fresh-clone run and committed.
- Every lane had to finish with a written report: files touched, how to run, done, not done, and what it threw away. The integrator read the reports and then checked the claims itself instead of trusting them.

## 2. Prompts and lanes

| time | lane | what we asked for | result |
|---|---|---|---|
| 15:50 | lead | Read the packet and starter. Write the hard rules, the build contract and the shared types | `CLAUDE.md`, `CONTRACT.md`, `starter/lib/contract.ts` |
| 16:00 | AGENT | Build Lane AGENT to the contract: a real tool loop, Seller-Sim and Driver-Sim, read tools, triage, reconcile before retry, the case-law gate with a leave-one-out eval, proposals / approvals / trust with their APIs, the Scribe handover, a background runner without a cron library, a `node:test` self-check | 10 routes, 5 replay fixtures, 15/15 self-check, eval 3/10 leave-one-out, Ringo eval 38/38 |
| 16:00 | UI | Build Lane UI to the contract: queue home, order story, trust ledger. Stubs until the routes exist. `npm run build` must pass | Queue, story, trust pages; headless-Chrome screenshots against stubs |
| 16:00 | MATRIX | Learn the real Matrix OS formats from its source. Write manifests, cron entries, a dry-run deploy and README text. Mark every unverified assumption | `matrix/` (manifest, cron, box loop, deploy.sh), assumptions A1 to A10 |
| 16:40 | integrator | Wire the UI to the real routes, run everything live, review against the judging criteria, fix the top issues, write README and PROCESS, fresh-clone run, commit | This commit series |
| 17:10 | polish | Judge the queue and pages by Bahn's rubric (only orders that need a person, with just enough to decide; one glance, calm, hundreds of orders). Make every row specific, re-check triage, quieter colours, tab title, screenshot every page at 1440 and 390, test the sibling-STALE fix | §6 below |
| 18:15 | integrator | Rename Ring → Ringo, add the mascot, a places map, and a Matrix base path; check it all in a production build with and without the prefix | §6c below |

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
- `npm run ring:check` (node:test, 19 tests since the polish pass): triage on the demo orders, gate rules, speech rules, and the evidence ladder. It exits non-zero on a broken assertion. An earlier `process.exit` workaround hid failures (exit 0 on a broken test); it was replaced by closing the DB pool.
- `npm run eval:ring`: Ringo live on the five demo orders, with 38 assertions from CONTRACT §8 (read before dialling, no customer contact, never `verified`, 010's second call carries `reconciled`, 023 does not change the address, and so on).
- Every route was called over HTTP, including the error paths: reject without a note (`NOTE_REQUIRED`), promoting a locked row (`LOCKED`, 409), promoting without five clean approvals (`NOT_PROMOTABLE`, 409), a second run on a busy order (409), unknown order and run (404), and a `STALE` execution after a synthetic newer event.

**What the integrator found and fixed (things the lanes had reported as done)**
1. **Approving the second proposal from one run always failed.** Ringo on 516 wrote two proposals (record access, record contact) on the same read. Approving the first wrote an event, so the second one's basis was now "old" and it went `STALE`, which put 516 back in Needs you as a failed action. Neither lane had tested approving two proposals in a row. Now sibling proposals from the same run that change a different kind of thing do not make each other stale; any other newer event still does.
2. **A one-hour DST error in the phone simulator.** The 516 site persona said the slot was 10:00 to 13:00 Helsinki time, but the slot is 07:00 to 10:00 UTC on Mon 26 Oct, after the clocks went back on 25 Oct, so it is 09:00 to 12:00 EET. The story page, which formats the slot from the row, showed 09:00 while Ringo's quoted fact said 10:00. We fixed the persona and re-recorded the replay fixtures.
3. **"What Ringo did" mixed the tools' record with the model's own account.** The list merged code-written lines with the model's `did` lines, which repeated each other and could claim things no tool did. It is now built only from what the tools actually did (calls, proposals, refutations, facts written).
4. **Facts showed who and when, but not which record.** Each fact now names its source record ("message", "Ringo call", "slot record"), carries the source id on hover, and links to the timeline entry when the source is on the timeline.
5. **Raw codes and ISO strings on screen.** "Selected pickup slot 2026-10-26T07:00:00Z to …" and "PICKUP_PHOTOS proof is submitted" are now "Selected pickup slot: 26 Oct 09:00–12:00 EET" and "Pickup photos submitted".
6. **An overtaken signal still showed as a current fact.** On 322 the 05:16 tracking gap was struck through in the decision panel but listed as current under "What we know". It now folds into "no longer true or out of date".
7. **Long timelines.** 322 has 33 entries, with the ones that matter at the bottom. The timeline now shows the latest 10 and folds the rest behind "Show 23 earlier entries".
8. **Trust page.** Four disabled dark "Let Ringo do it" buttons read as broken. The button now appears only when the row can be promoted; the row text already says what is missing.
9. **The Matrix box loop ran the background script without the shim**, so `server-only` would fail to resolve on the box. It now uses the same `--require ./scripts/ring-shim.cjs` as `npm run ring:background`.
10. **"Offline" said twice.** Without a key the Ringo panel showed the offline note and a red error line with the same words, plus a misleading "Ringo last ran" line for the failed attempt. It now says it once, with the Replay button.
11. **The UI stubs.** They are deleted (`app/_stubs/`, the "Sample data" banner). The UI talks only to the real routes; a route error shows as an error, not as made-up data.

## 4. What we threw away

**Planning**
- The starter's lane board as the home page. It moved to `/board`, and the queue replaced it.
- A separate "Ringo Monitor" app. It is folded into the one ops app.
- ElevenLabs voices, and live voice as a requirement. The transcript comes first, with an opt-in browser `speechSynthesis` "Listen" button.
- The idea that "the 14 proposals contain 13 corrections". The real number of review signals is 10 (3 edited, 1 rejected, 1 failed, 5 approved with conditions).

**Lane AGENT: first answers we did not take**
1. **Strict tool schemas everywhere.** All-strict tools got a 400 ("compiled grammar is too large"). Strict stays on the 7 small tools; the 3 big ones (`record_fact`, `propose_action`, `stop_with_decision`) are validated in code.
2. **516, first run.** Ringo stopped `needs_person` without calling stock control, which the site itself had named as the next step. On the second run it called, but refuted the customer's "reception has keys" without recording it first. The prompt was rewritten twice in general terms, not order-specific ones: calling the site is Ringo's job, and a claim on record is recorded as `claimed` and then refuted from the later site statement.
3. **The ring-call evidence cap.** The first version allowed `quoted` only after hang-up, which rejected valid facts during a live call. It now depends on whether the site person has spoken.
4. **010 redial.** Ringo redialled right after the dropped call. The guard allowed it because Ringo had re-read, but the contract wants a callback, so the prompt now says to schedule one and stop as "waiting".
5. **023 address.** Ringo tucked the street address into an `endpoint.record_access` proposal. A street address is customer input, so it must be a locked `address.update`.
6. **458.** Ringo proposed a `pickup.hold` when it should propose nothing; it now stops `needs_person`.
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

**Ringo behaviour** (`npm run eval:ring`, live model, `claude-sonnet-5-5`): **38 / 38** on the integrator's run (24 Oct 16:44). The first full run by Lane AGENT scored 35 / 38; the three misses led to prompt fixes 2, 4 and 6 above. The model's behaviour varies between runs, so this is one sample, not a guarantee.

| order | what is asserted | pass? |
|---|---|---|
| CD-420516 | reads before dialling; records "reception has keys" as claimed and refutes it from `msg-x5d8006558b9e7cc6` without re-asking reception; records a quoted fact from the call; proposes `endpoint.record_access`; stops `proposal_ready` | 9 / 9 |
| CD-420458 | does not call; proposes nothing; no customer contact; stops `needs_person` | 7 / 7 |
| CD-420593 | asks the driver; a driver instruction goes to a person; no customer contact | 7 / 7 |
| CD-420010 | first call `DROPPED_UNKNOWN`; schedules a callback; second call carries `reconciled`; proposes `endpoint.record_contact` | 8 / 8 |
| CD-420023 | does not change the address; proposes `address.update` (locked ask); stops `proposal_ready` | 7 / 7 |

Every order also asserts: the run finished, read before dial, no customer contact, never `verified`.

**End to end in the browser** (integrator, headless Chrome clicking "Run Ringo"): 516 finished in 48 s with one proposal and a stop card; 023 in 35 s with two proposals and a stop card; Replay on 593 streamed the recorded run. Approving both 023 proposals (record access, then the address update) executed both and moved 023 to quiet. With a synthetic newer event on 516, approval still came back `STALE` and changed nothing.

**Fresh clone** (integrator): `git clone` of the `ring` branch into an empty folder, then the README steps with Compose v1 on other ports (Postgres 5448, RustFS 9019/9020) and no model key. `npm ci`, `db:push`, `db:seed` (100 orders), `attachments:seed` (58 files), `ring:check` 15/15 and `eval:reviewer` 3/10 all ran. The queue, story, trust and board pages served; a live run streamed "Ringo is offline: no model key" and Replay streamed the recorded 010 run. The stack and its volumes were removed afterwards.

## 6. Polish pass (17:10 to 17:30)

**Triage, re-checked row by row against the messages and work items.** The queue had 19 rows and five said only "A driver asked something and nobody has answered."
- **Each driver row now quotes the driver** (the whole message when short, else the sentence with the question): 413 "Please tell me who confirms Tuesday's keys and where I should report", 399 "Please check a replacement or ask the customer about another slot", 201 "I paid 12 EUR for parking… please review it".
- **The driver rule only fires on a message that asks something** (a question mark, "please", "can/could you"). Two rows were false: 419 was the driver's "Understood… I have no cost to submit" on a cancelled collection (now quiet: closed thread, nothing open), and 603 was a position update.
- **603 did need a person, for a different reason**: an OPEN high ferry-cutoff alert nobody had acknowledged. Checking every open alert found **702 hidden as "quiet"**: "Original customer delivery window ends today… no revised promise is approved" (OPEN, high). Rule 8 now also fires on an OPEN, unacknowledged high alert (not the site-access one, which is Ringo's). When the alert summary is the generated "Review … for CD-…", the row quotes the message that raised it.
- **"Quiet" now means what it says.** 194 (invoice query) and 455 (mark after delivery, customer asked us to wait for a branch photo) had open alerts but counted as quiet. They go to "Waiting on others" as "Being followed up in the conversation", not to Needs you: nobody has to decide anything yet.
- **Rows say what is wrong, not what to do.** Task rows use the work item's summary ("The booked driver has not confirmed fitness…") instead of "Due already: Obtain a definite driver response and…". The failed-action row names the action and the error: "Attempt to book the next-day quoted vehicle crossing failed at 07:10 UTC: Provider request timed out without a confirmation reference."
- **"Overdue by 24 h" was often false.** `decideBy` took the earliest of all times, so a car already on the road showed its past pickup slot as overdue (071 said "due within the hour" next to "Overdue by 24 h"). It now uses the open task's due time, and a pickup slot only before pickup.

**The final count is 19, and each is a person's call** (checked against what Ringo may do in the trust ledger): safety (322); a failed ferry booking to reconcile (299, booking = locked); seller hold (458); driver on site with no car (593); three drivers waiting on an answer that is a driver instruction, a replacement or a cost (399, 413, 201); a backup-driver decision 22 h overdue (449); no authorised receiver for a car in transit (437); a live offer to withdraw (347); a three-way site handover (689); a ferry cutoff nobody owns (603); a delivery promise that can't be kept (702); and, in the lower group, a recorded proposal to review (055), a missing VIN that needs the customer (009), a missing signed handover (164), two dispatch reviews (941, 992) and rejected pickup photos (071). None of them is something Ringo can do by phone; the three it can (516, 010, 023) stay under "Ringo is on it". We did not cut rows to hit a number.

**Look and feel** (headless Chrome over the DevTools protocol at 1440 and 390 wide, because plain `--window-size=390` renders at Chrome's ~500 px minimum and hid the real mobile layout):
- Needs you is split into **Now** (critical and high) and **When you can** (routine), in rank order inside each.
- Status words are muted; only Ringo's teal stays. **Red is only an overdue card that needs a person**; Ringo's and waiting rows never go red. Fixed-width status and due columns so the reason text lines up row to row (the `auto` column made every row a different width, and "Overdue by 11 min" spilled out of its 104 px).
- "What we know" was a ragged mix of one-line pills and boxes; it is now one aligned list (level, claim, then who · record · when), stacked on phones.
- The trust page showed "Accepted as is 0 · Edited 0 · Rejected 0" on all 14 rows and a made-up "Set 09:22" (the default row's time was `now`). It says "No reviews yet" and "Default setting" until there is something to count.
- Tab title and metadata: "Ringo — Bahn control room"; order tabs end in "· Ringo".
- The empty queue ("Nothing needs you") was checked by answering `/api/agent/queue` with an empty queue in the browser, not by resetting the shared DB.

**Tests.** `ring:check` is 19/19: new tests for the driver quote, the acknowledgement that needs no answer, the unacknowledged high alert, and **recheck before write**: two sibling proposals from one run both execute, while any other newer event still makes the approval `STALE`. With the sibling fix removed, the sibling test fails (checked). The test writes to a quiet order and deletes its own rows. `eval:reviewer` is unchanged at 3/10 leave-one-out.

**Thrown away:** cutting the count by moving routine tasks (164, 941, 992, 071) out of Needs you. A person must still act on them; they sit in "When you can" instead. A third "overdue" group, because the sim clock makes rows drift into it every few minutes.

## 6b. Judge pass (17:45)

A 30-second look as a judge, on a production build (`next start` on a spare port; Next 16 refuses a second `next dev` in the same folder, and :3000 belonged to another project), with headless Chrome at 1440 and 390. The live model was called once (the first handover); everything after ran with the key unset and the recorded replay. The five biggest things a judge would notice:

1. **"Since you left" was a grey skeleton for several seconds on every cold start**, because the route waited for the Scribe (an LLM call) before answering. Fixed: the page gets the template sentences (each with its source) at once, the Scribe writes in the background into the same cache, and the strip asks once more after 12 s. `?format=text` (cron/Telegram) still waits for the Scribe.
2. **Driver rows were cut before the question.** 413 read "Understood. I will only collect the first Golf on Monday. Please tell me who…": the whole message fit under 150 characters, so it was shown whole and the two-line clamp hid the ask. Fixed: a quote is whole only up to 100 characters (two lines at 1440), and the filler first sentence ("Understood.") is no longer used as a lead. 413 now reads "Please tell me who confirms Tuesday's keys and where I should report", 201 "I have submitted the receipt; please review it".
3. **Ringo rows read "Ringo can ring the pickup site: Get stock control's…"**, three times in a row and again as the order's headline. Now "Ringo can call the site to get stock control's…".
4. Not fixed: after a recorded run finishes, the button still says "Ringo is working…" until "Stop watching".
5. Not fixed: Ringo rows show "Overdue by 36 min" (grey) while the order page says "No decision is waiting on you"; the due time is the site's task, not the desk's. And the sidebar wordmark says "Control Room" while the tab says "Ringo".

**Thrown away:** a timeout race around the Scribe (still a skeleton for the length of the timeout); polling until the Scribe answers (a loop for one swap).

## 6c. Ringo, the map and the Matrix base path (18:15)

**Renamed Ring → Ringo on 24 Oct.** Everything a person reads says Ringo: UI strings, tab titles ("Ringo — Bahn control room"), the system prompt (it calls itself Ringo), the phone and driver sims' persona prompts, handover sentences, the docs, the Matrix manifest and cron text. Internal identifiers stay as they were to avoid churn: the `ring_*` tables, `lib/ring-schema.ts`, file names, `ring:*` npm scripts, `/api/agent/*` paths, CSS classes and the `RING_*` triage codes. The replay fixtures were string-mapped (`Ring` → `Ringo`, whole word only, e.g. "Hier ist Ringo, Abholplanung"); nothing else in the recorded model output was touched. The shared DB had no Ringo rows, so there was nothing to map there.

**Mascot.** `public/ringo.svg` (drawn earlier, not redrawn) appears three times: a 28 px head-and-shoulders crop next to "Ringo" in the sidebar (which said "Control Room" until now, see 6b point 5), a 26 px crop in Ringo's panel on the order page, and the full figure at 140 px on the empty "Nothing needs you" state with one dry line ("Quiet on the lot."). The crop is CSS on an `<img>` (`.ringo-face`), so there is one file. The favicon is `app/icon.svg`, the same drawing with a cropped `viewBox`.

**Map** (`/map`, sidebar "People and places → Map"). A server component that draws inline SVG from `lib/europe-map.ts` (Natural Earth outlines and real city centres, pre-projected): no map library, no tiles, no external requests. Places are shown at city level only, with the caption "Places shown at city level. Addresses in this dataset are fictional." Dots are area-proportional to the 132 addresses; a red ring means an order with a pickup or delivery in that city is in Needs you, taken from the queue's own `triageAll` (not a second copy of the rules); faint arcs are the 24 orders in transit; squares are the 4 ferry terminals. Helsinki, Espoo and Vantaa sit within a few km, so they get a zoomed inset; labels only for cities with ≥ 3 places or an order that needs you, and every city has a `<title>`. `?city=Name` opens the side panel (plain links, works without JS): the orders there that need you, then places grouped by kind. The base layer is `role="img"` with a one-sentence summary; city links are keyboard-focusable and also listed in the panel, which is the easier way in on a phone. City clicks send `map_city_opened` to PostHog (only when PostHog is configured, like the other events); prefetch is off on those links because each map render triages every order.

**Matrix base path.** Matrix serves apps under `/apps/<slug>`, so `next.config.ts` sets `basePath` from `NEXT_BASE_PATH` (empty by default) and exposes it as `NEXT_PUBLIC_BASE_PATH`. `<Link>` and the router add it themselves; raw `fetch`, `<a href>` and `next/image` do not, so they go through `withBase()` (`lib/base.ts`): the agent API client, the order, record, entity, inbox and board fetches, the attachments list, the two "order API" links and the car illustration. `deploy.sh` and `matrix.json` build and start with `NEXT_BASE_PATH=/apps/bahn-ring`; the box loop adds it to its app URL.

**What we checked**
- `NEXT_BASE_PATH=/apps/bahn-ring next build && next start`: every page, `/icon.svg`, `/ringo.svg`, the queue and order APIs and a POST to the run route answered under the prefix; headless Chrome on `/`, `/map`, `/map?city=Hamburg`, the 516 story and record pages, `/trust`, `/board`, `/inbox`, `/sites` and a site page logged no 4xx and no failed request (the car image loads).
- The same without the variable: everything at the root as before, `/apps/bahn-ring` is a 404, and `npm run smoke` passes.
- Screenshots at 1440 and 390 (viewport set through Playwright) of `/`, `/map`, `/map?city=Hamburg`, the 516 story and `/trust`, plus the empty queue (the queue response emptied in the browser, not in the DB). No horizontal scroll at 390.
- `typecheck`, `build`, `ring:check` 19/19, `eval:reviewer` unchanged at 3/10 leave-one-out.

**Thrown away:** the SVG `#svgView()` fragment for the crop (CSS is certain to work everywhere); one clickable dot per capital-region city on the main map (they overlapped, so the inset holds the links); CSS stroke widths on the map (CSS beats SVG attributes, which made the inset's rings 5× too thick); a `max-height` on the map, which shrank labels to 9 px; prefetching every city link.

## 6d. Clumsy-user run (24 Oct, evening)

Three persona agents (impatient lead, keyboard user, new dispatcher) clicked through Bahn at 1440 and 390. The run found these bugs; fixed:
- Every model call failed with 400 because PostHog fields reached `beta.messages` (fixed earlier, separately).
- **A failed run showed raw API JSON with a request id three times and replaced the order's decision card.** A failed run now stops with outcome `failed`: triage and the story skip it, so the order keeps its real card, and the run panel says it once ("Ringo couldn't reach its model. Nothing changed. Try again or work it by hand.") with the raw text folded under "Technical details" (wraps on a phone).
- "Since you left" printed `Ringo stopped (needs_person)`; it now says "Ringo needs a person".
- On a phone, Run Ringo scrolled under the sticky top bar and the tap opened "Needs you": `scroll-padding-top` at the mobile breakpoint. The top bar fades at the right edge so it reads as scrollable.
- `ORD-00010`, ` ord-00010` and `/places` were dead ends: `proxy.ts` redirects to the lower-case id (pages and APIs) and `/places` to `/sites`. An unknown order is a real 404 from `orders/[id]/layout.tsx` (no client fetches), with a plain not-found page.
- `/map?city=helsinki` found nothing, and the tab title echoed any query text: the city match ignores case, accents and spaces, and the title names only a matched city.
- Map dots were 15 px tap targets on a phone: a layer of invisible 44 px circles under every dot (a dot itself always opens its own city).
- Most tabs said "Ringo — Bahn control room": each page has its own title; an order's names its reference from the server.
- Keyboard: a skip link, Back from an order focuses the row it was opened from, Escape leaves the chat box and stops watching a run.

Left, because they are outside the order flow and nobody hit them: customer, driver and site pages with an unknown id still render their own "not found" with HTTP 200. Then `POST /api/agent/reset` cleared the 4 failed persona runs plus the day's test runs; the queue is back to the §8 picture (322 first, 458 and 593 in Needs you, 516/010/023 with Ringo).

**Second clumsy-user run (24 Oct, late evening).** The first run sent PostHog no events at all: posthog-js captures nothing when `navigator.webdriver` is true or the user agent says HeadlessChrome. The persona browsers now hide both, and PostHog got event batches (all 200). No session recordings: recording is off in the PostHog project, not in the code. The run found these bugs; fixed:
- On a phone, a tap 8 px left of "Watch a recorded run" started a live Ringo run, because the buttons were only 8 px apart. The gap is now 20 px.
- A reload, or a second tab, during a live run showed "Run Ringo" enabled and "Ringo last ran …", as if nothing were running. The panel now reads the running run from the story: "Ringo is working on this order now (started …)", with Run and Send disabled (same 10-minute cutoff as `liveRun()`).
- While a replay played, the main button said "Ringo is working…". It now says "Replaying…".
- Cancelling Edit kept its note, which then showed up as the reason when you pressed Reject. Cancel now clears the note.

Left, because nobody would act on them: about a third of PostHog event POSTs were aborted. These are the scripts' hard `page.goto` navigations cutting off in-flight beacons; normal in-app navigation doesn't do that. Customer, driver and site pages with an unknown id still return 200 (as before). Then `POST /api/agent/reset` again.

**Live runs behind a 30 s proxy (25 Oct).** On Matrix OS the gateway aborts every proxied request after 30 s total, streamed body included. A live run takes 35 to 48 s, so the browser got a 504 and saw nothing, although the run finished on the server. Now `POST /api/agent/orders/[id]/run` starts `runRing` in the background (kept alive with `after()`) and answers `202 {runId}` once `run_started` is stored. The panel then polls `GET /api/agent/runs/[runId]?after=<seq>` every second until `run_ended`, and renders the same events as before. The 409 "already running" and Escape (stop polling only) behave as before. Replay still streams, because it is under 25 s. A real run on ord-00023 took 37 s; the longest single request was 0.7 s (33 polls).

## 6e. The lizard cast (25 Oct)

Ringo got three colleagues, one per role, so a reader can scan "who said it" before reading the name. All four are 214x240 SVGs drawn from the same parts (`public/ringo.svg`, `lizard-dealer.svg`, `lizard-customer.svg`, `lizard-driver.svg`): same body, pose, palette and line weights, head in the same place, so one CSS crop (`.lizard-face`) serves all of them. Each has one cue that survives 22 px: Ringo's sunset aviators and teal, the dealer's black quiff and mustard plaid, the customer's round glasses and navy, the driver's rust flat cap.

- **The plaid moved to the dealer.** In the story the 80s used-car salesman is the pickup site, the one who hands the car over, so the joke now lives where it belongs. If Ringo kept the plaid too, two plaid lizards would be one blur at 22 px. Ringo keeps everything that makes him Ringo (aviators, moustache, gold tooth, crest, thumbs-up) and gains a headset with a mic boom, a teal jacket (the app's Ringo colour) and a coffee mug instead of the SOLD tag.
- **No rude gestures.** Thumbs-ups keep the thumb out the side of a closed fist. The crop is a 124 px square at (44, 14) that stops before the raised hand, so a cropped thumb can never look like a lone finger. The favicon (`app/icon.svg`) uses the same square.
- **Where they show.** A 22 px face beside every timeline entry and every "What we know" source line: driver, customer, site (dealer) or Ringo, mapped from the existing `actorKind` and fact source; Bahn people, monitoring and system events get a neutral dot of the same size so rows stay aligned. The name stays; the face is never the only cue (alt = the role). An event only gets a face when its label names the actor, so "System: offer accepted by Yara" never shows a driver beside "System". A fact from a Ringo call shows the dealer, because the site said it. "Nothing needs you" shows the four together.
- Checked: renders at 22, 28, 48 px and full size, order pages ord-00593 / 00516 / 00413 and the empty queue (queue response faked in the browser) at 1440 and 390.

## 6f. UI feel: queue, order hero, board (25 Oct)

A design critique said the queue led with the car, said "A person must act" 11 times, and the board and queue disagreed (43 vs 19). What changed:

- **Queue rows** lead with the problem; "CD-xxxxx · car" is a muted second line. The status column is now a next-step chip from `lib/triage/next-action.ts` ("Answer driver", "Call site", "Decide: roadside or tow", "Review proposal"), or nothing when no concrete step is known. Severity is a 3 px left edge, safety rows get a faint tint, and anything overdue goes in Now. Keyboard j/k and focus restore checked.
- **Ringo's shift report** replaces the grey "Since you left" card: his face and three lines in his voice. Counts link to the rows they count; the cited handover sentences stay one click away behind "Show what happened", so every line still has its source.
- **Order hero** is the problem, one "Next:" line and the buttons that do it. The next step comes only from rows already on the story (Ringo's proposal or stop decision, the one-decision template, the open task's next action, an unblocked recorded proposal). Recorded and blocked proposals fold into "Earlier proposal (blocked by reviewer check)". On 322 it reads "Next: Decide with the customer: roadside or tow", with the cited facts under it and a button to the customer. No new backend actions.
- **Board** counts "Needs you" from the queue's triage list, so both pages say 19. Lanes are 300 px with snap, an edge fade and a step button; footers end in an ellipsis; mark icons have titles. On a phone a stage picker shows one lane at a time.
- Checked at 1440 and 390, including a faked "Ringo proposal waiting" story and a failed handover (both faked in the browser; nothing written, no runs).

## 6g. Cast where it delights (25 Oct, UI feel pass)

A critique said the faces read as green blobs at 16 to 28 px, Bahn people got grey dots, and Ringo's panel was a big header even where he can't act. What changed:

- **Faces.** The crop is now the head only: the 104x104 square at (58, 8), centred on the face and clear of the raised hand (was 124 at (44, 14), which spent half the circle on the collar). Each face sits in a circle with a 2 px ring in its role colour: Ringo teal, site ochre, customer navy, driver rust. 28 px in the timeline and fact lines. Support desk, shift lead, dispatch, monitoring and system get a muted monogram (SD, SL, D, M, S) of the same size. Still one SVG per lizard, cropped in CSS; nothing redrawn.
- **Ringo in moments.** While a call is open the run panel says "Ringo is ringing Velantora Helsinki…" (name taken from the dial step) next to his head with a pulsing ring; under reduced motion the ring holds still. A run that ends with a proposal gets a thumbs-up crop and "Done. Over to you." When Ringo can't act on an order, his panel is one line with a 24 px head: "Ringo stands back here. On-the-road safety. No calls, no messages." (the decision card already says a person owns it).
- **404.** The dealer with his SOLD tag, "This one's already gone.", one button back to the queue. No internal ids.
- **/trust.** 64 px Ringo by a shorter intro; "No reviews yet" once in each section note instead of 14 times; the never rows carry a slashed-circle "Never" chip instead of a key "Locked"; locked ask rows say "Always asks". "Meet the crew" at the bottom shows all four, linked from the sidebar foot.
- **Shell and map.** The sidebar's divider moved to `.main`, so it runs the full page height. On a phone the top bar ends in a pinned chevron over a fade. `/map?city=` dims other cities and the road arcs to 30% and gives the chosen city a halo and a bold label.
- **Checked** with the run API faked in the browser (no live run, no model call): order 516 ringing and done, order 322, /trust, the 404, /map?city=Hamburg, at 1440 and 390.

Left: the queue's empty states and the inbox (another lane owns those pages, so the line-up isn't placed there); status copy in `bits.tsx` ("A person must act") belongs to the queue rework.

## 7. Known gaps

- Nothing has run on a real Matrix OS box yet. The deploy script is a dry run until `--apply`, and assumptions A1 to A10 (Node 24 on the box, Docker, and so on) are unverified. Serving under `/apps/<slug>` works in a local production build with the base path; whether the gateway keeps or strips the prefix on a real box is not checked.
- `/orders/516` is not a route; order pages use the row id (`/orders/ord-00516`).
- The gate's leave-one-out score is low (3/10) for the reason above.
- No speech input in the Ringo chat box; earlier runs are not browsable (only the latest run's headline shows).
- Ringo prepares no customer-message drafts. The background runner's `--autorun` is off by default so it cannot take over a live demo.
