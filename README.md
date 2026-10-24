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
- **CD-420322** (a car stopped on the road) is not a Ringo order. It gets a one-decision card built from the records.
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

**After `npm run demo:seed`** (no model key, nothing is invented):
- Needs you holds Ringo's recorded proposals for CD-420516, CD-420010, CD-420023 and CD-420593, waiting for you to accept, edit or reject them (on the order or in Decide). They come from five real recorded runs (`starter/lib/agent/fixtures/*.ndjson`), stored with trigger "replay". Each order's timeline shows the simulated calls.
- CD-420458 shows Ringo's recorded "seller hold, a person decides" stop. CD-420322 is the safety card; Ringo never runs on it.
- `/evals` shows the three recorded scenario-suite runs from 24 Oct (`starter/eval/suite-2026-10-24-r3.json`, 29 of 30 passed, the miss included) and the Reviewer gate's honest leave-one-out score (3 of 10).
- No review, correction or learned rule is seeded: approve 516 yourself to see the approved state, and a learned-rule suggestion only appears after you correct Ringo the same way twice.
- Without `demo:seed` the app starts empty: "Ringo has not run" on every order and an empty `/evals`, until you run Ringo (with a key) or watch a recorded run.

- **Ports.** Postgres is on 5438 and RustFS on 9009/9010. If a port is taken, change it in `starter/compose.yaml` and in the matching line of `starter/.env`.
- **The model key.** It is read from `starter/.env.local`, never printed and never committed. The model is `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`. Without a key the app still works: triage, the queue, the stories, reviews and trust need no model, and Ringo shows "offline" with **Watch a recorded run**, which replays a real recorded run for the five demo orders.
- **Demo orders:** CD-420516 (key holder unknown), CD-420010 (the first call drops), CD-420023 (no street address), CD-420593 (driver on site, car not there), CD-420458 (seller hold, Ringo must not call), CD-420322 (safety, not a Ringo order). `POST /api/agent/reset` clears all Ringo rows and restarts the sim clock at the dataset snapshot (Wed 21 Oct 2026 09:00 UTC).

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
