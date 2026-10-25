# Ringo: a control room for Bahn car delivery

Our entry for Bahn's Car Delivery Control Room challenge (Prompt Operations Hackathon, 24 to 25 October 2026). Bahn's original challenge README follows further down.

**The control room** shows one queue: only the orders that need a person, each with one line saying why and when it must be decided. Order pages read as a story. Every fact shows how sure we are (claimed, quoted, reserved, observed, verified, out of date, refuted), who said it, which record it comes from, and when.

**Ringo** is a real LLM agent for pickup readiness. On an order it:

1. reads the order, its messages and the site rules first (it cannot dial before it has read);
2. rings the pickup site through a phone menu and talks to a person there, or asks the assigned driver a question (both are simulated, and every simulated call and message is labelled);
3. writes down what it learned as graded facts, each citing a real source;
4. either finishes, or stops with one clear decision for a person and proposals to accept, edit or reject.

Ringo never contacts a customer. It never changes a booking, a date, a cost or an address on its own, and it never gives mechanical advice. These rules are enforced in code (tool guards, a deterministic Reviewer gate, a trust ledger), not only in the prompt.

Around it:

- **Reconcile before retry.** After a dropped call, Ringo must re-read and say what it found before it redials.
- **Recheck before write.** Approval re-checks the order. If it changed after Ringo read it, nothing is written and the order comes back as "check before retrying".
- **Reviewer gate.** Case law from the dataset's 14 reviewed agent proposals, checked by plain code (no model), with a leave-one-out eval.
- **What Ringo may do** (`/trust`). Each kind of action is auto, ask or never. Ask rows can be promoted after five clean approvals in a row; bookings, dates, costs, addresses and customer messages are locked to ask.
- **Since you left.** A handover strip on the queue in which every sentence links to its sources. A sentence whose source cannot be found is dropped and counted.
- **CD-420322** (a car stopped on the road) gets a one-decision card built from the records: roadside or tow is a person's call. Ringo works it only in **roadside mode**: driver-only and safety-limited, he may ask the driver if they are safe and where exactly they are, ask for the warning-light photo, and send one holding reply ("a person is arranging recovery, stay with the car"). He writes the answers down as claimed facts and stops for a person. Code refuses calls, proposals, callbacks, instructions and any wording about starting or moving the car.
- **Map** (`/map`). Every place in the dataset at city level (the addresses are fictional streets in real cities), cities with an order that needs you ringed in red, cars on the road as faint pickup-to-delivery lines, ferry terminals as squares. Click a city (`/map?city=Hamburg`) for its places by kind and the orders there that need you. Plain inline SVG, no map service.

How we built it with coding agents, what we checked and threw away, and the eval numbers (including the misses) are in [`PROCESS.md`](PROCESS.md). The hard rules are in [`CLAUDE.md`](CLAUDE.md), and the build contract is in [`CONTRACT.md`](CONTRACT.md).

### Run it from a fresh clone

You need Node.js 24 or newer, Docker, and, for live Ringo runs, an Anthropic API key.

```sh
git clone https://github.com/dianapaula19/bahn-ringo.git && cd bahn-ringo/starter
cp .env.example .env
echo "ANTHROPIC_API_KEY=<your key>" > .env.local   # optional, see below; .env.local is gitignored
npm ci

# Postgres + RustFS. Docker Compose v2:
docker compose up -d --wait
# Docker Compose v1 has no --wait: start, then wait until both services say "healthy"
docker-compose up -d && docker-compose ps

npm run db:push            # creates the starter tables and Ringo's ring_* tables
npm run db:seed
npm run attachments:seed
npm run demo:seed          # optional: the recorded runs and test results the video shows (no key needed)
npm run dev                # http://localhost:3000
```

**What `npm run demo:seed` creates** (no model key, nothing is invented; it prints the same list when it finishes):
- **7 recorded runs** from six real recorded fixtures (`starter/lib/agent/fixtures/*.ndjson`), stored with trigger "replay", with their steps, 5 simulated calls, 4 simulated driver messages and 20 facts. Each order page shows the last run as a strip of steps (read order, read messages, read site rules, read playbook, the call, the stop) with how long each took, and `/engine` labels them "recorded run, no token data".
- **5 proposals waiting for a person**: Needs you holds Ringo's proposals for CD-420516, CD-420010, CD-420023 and CD-420593, to accept, edit or reject on the order or in Decide.
- **10 site playbook notes**, rebuilt from those runs' own `note_playbook` calls and checked against the call transcripts the same way the live tool checks them. Velantora Helsinki's playbook (`/sites/site-001#playbook`) shows what stock control said on the 516 call, in Finnish with the English beside it.
- CD-420458 shows Ringo's recorded "seller hold, a person decides" stop. CD-420322 is the safety card, with Ringo's recorded roadside run: he asked the driver where exactly the car is and for the photo, sent the holding reply, and wrote three claimed facts that the card folds in.
- `/evals` shows the three recorded scenario-suite runs from 24 Oct (`starter/eval/suite-2026-10-24-r3.json`, 29 of 30 passed, the miss included) and the Reviewer gate's honest leave-one-out score (3 of 10).
- **Not created:** no review, no correction, no learned rule and no "I'll handle it" claim. Approve 516 yourself to see the approved state; a learned-rule suggestion on `/trust` only appears after you correct Ringo the same way twice. If your `/trust` already shows one, your database has reviews from an earlier session: `POST /api/agent/reset`, then `npm run demo:seed` again.
- Running it again is safe: it clears Ringo's rows on those five orders (runs, calls, facts, proposals, callbacks, claims and their playbook notes) and rebuilds them from the recordings.
- Without `demo:seed` the app starts empty: "Ringo has not run" on every order and an empty `/evals`, until you run Ringo (with a key) or watch a recorded run.

- **The sim clock.** The data is a snapshot taken Wed 21 Oct 2026 at 12:00 Helsinki time, so the desk runs on a simulated clock. `.env.example` sets `RING_CLOCK_SPEED=0`, which freezes the desk at 12:09 Helsinki, just after the recorded runs: the queue reads the same whether you open it a minute or a day after `demo:seed`. With `1` (the default when the line is missing) the clock runs forward in real time from the end of `demo:seed`; hours later most deadlines have passed and the queue fills with overdue rows. Live runs on a frozen clock share one time stamp, so their steps show "<1 s"; set `1` if you want run timings.
- **Ports.** Postgres is on 5438 and RustFS on 9009/9010. If a port is taken, change it in `starter/compose.yaml` and in the matching line of `starter/.env`.
- **The model key.** It is read from `starter/.env.local`, never printed and never committed. The model is `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`. Without a key the app still works: triage, the queue, the stories, reviews and trust need no model, and Ringo shows "offline" with **Watch a recorded run**, which replays a real recorded run for the five demo orders.
- **Demo orders:** CD-420516 (key holder unknown), CD-420010 (the first call drops), CD-420023 (no street address), CD-420593 (driver on site, car not there), CD-420458 (seller hold, Ringo must not call), CD-420322 (safety: a person decides; Ringo in driver-only roadside mode). `POST /api/agent/reset` clears all Ringo rows (runs, proposals and their reviews, corrections, learned rules, claims, playbook notes; the recorded test results stay) and restarts the sim clock at the dataset snapshot (Wed 21 Oct 2026 09:00 UTC).

### Checks

Run from `starter/`:

```sh
npm run typecheck && npm run build
npm run ring:check                 # node:test self-check: triage, gate, evidence ladder (no model)
npm run eval:reviewer              # Reviewer gate, leave-one-out;  -- --all for the leaky upper bound
npm run eval:ring                  # Ringo live on the 5 demo orders, 38 assertions (needs the key; clears their Ringo rows)
npm run eval:suite                 # ten scenarios, live (needs the key); run it on a separate eval database
npm run ring:run -- ord-00516      # one live run in the terminal
npm run ring:record                # rebuild the replay fixtures from stored runs
```

### Background work and Matrix OS

`npm run ring:background` does one pass: it triages every order and fires the callbacks Ringo has scheduled. Add `-- --loop` to keep it running (triage every 5 minutes, callbacks every minute). `--autorun` also starts Ringo on orders it can call and has never worked (at most 2 per pass); it is off by default.

To keep Ringo running on an always-on [Matrix OS](https://github.com/HamedMP/matrix-os) box:

```sh
matrix/deploy.sh                          # dry run: packs the repo (no env files, no node_modules) and prints every remote step
matrix/deploy.sh --apply --secrets=FILE   # FILE holds ANTHROPIC_API_KEY, and MATRIX_TOKEN + TELEGRAM_CHAT_ID for the 07:00 handover
```

The box loop (`matrix/box-loop.mjs`) runs the background pass every 5 minutes. At 07:00 Helsinki time it sends the "Since you left" handover to the operator's own Telegram chat through Matrix's channel; this is off unless `MATRIX_TOKEN` and `TELEGRAM_CHAT_ID` are set. On the box the app is built and started with `NEXT_BASE_PATH=/apps/bahn-ring`, because Matrix serves apps under `/apps/<slug>`; leave it unset locally. Details and the open questions are in [`matrix/README.md`](matrix/README.md). The deploy has only been dry-run; it has not run against a real Matrix account.

Everything is synthetic: no real people, companies, phone numbers or messages. The only external calls are the Anthropic API and, when its env vars are set, PostHog analytics.

---

# The Car Delivery Control Room

This is Bahn's challenge for the Prompt Operations Hackathon, 24 to 25 October
2026.

Bahn delivers used cars. A dealer sells a car, a driver from our network picks
it up and drives it to the buyer. Our agents already do a lot of the routine
work. The challenge is to build the place where people and agents work
together to get every car delivered, and one real agent for one part of the
job.

**Read `PARTICIPANT-BRIEF.md` first.** It says what to build, what to hand in,
and how we judge.

Everything in this repo is made up. No real people, cars, companies or
messages.

## What is in here

- `PARTICIPANT-BRIEF.md`: the challenge. Start here.
- `OPERATIONS-CONTEXT.md`: how car delivery work goes at Bahn, in plain
  words. Good reading for you and for your coding agent.
- `dataset/`: 100 made-up orders and everything around them: dealers,
  drivers, cars, bookings, messages, alerts, documents and events.
  `dataset/README.md` explains the files. `dataset/SCHEMA.md` explains every
  field.
- `attachments/`: made-up documents, receipts and photos that belong to those
  orders.
- `starter/`: a small web app that loads the data and shows it: a board of
  orders, an order page, a support inbox, and pages for customers, drivers and
  places. Use it, change it, or throw it away.
- `mockups/`: screenshots of the starter, so you can see it without running
  it.
- `check_packet.py`: a script that checks the data is complete. You do not
  need it, but you can run it with `python3 check_packet.py`.

## Run the starter

You need Node.js 24 or newer and Docker.

```sh
cd starter
cp .env.example .env
npm ci
docker compose up -d --wait
npm run db:push
npm run db:seed
npm run attachments:seed
npm run dev
```

Then open http://localhost:3000.

If port 5438 or 9009 is already in use on your computer, change it in
`starter/compose.yaml` and in the matching line of `starter/.env`.
`starter/README.md` has the details.

## Tips

- Point your coding agent at `PARTICIPANT-BRIEF.md`, `OPERATIONS-CONTEXT.md`
  and `dataset/SCHEMA.md` before you start. They explain the world better than
  the code does.
- The data is a snapshot. Nothing in it changes by itself. Your agent can
  pretend to send messages, make calls and book things. Nothing real is
  connected.
- Some of the data is messy on purpose. A message can disagree with an
  address. An alert is a reason to look, not a diagnosis. A quote for a ferry
  is not a booked ferry.
- The starter's board of lanes is how people have worked so far. It is not the
  answer.
- Questions: our channel on the event Discord, or our booth.
