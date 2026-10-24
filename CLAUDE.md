# Ringo: Bahn control room + pickup readiness agent

This is our entry for Bahn's Car Delivery Control Room challenge (Prompt Operations Hackathon, 24 to 25 Oct 2026). The hand-in is due Sun 25 Oct at 15:00: a 2 to 3 minute video plus a public repo that runs from a fresh clone.

**What we build:**
- **The control room:** one queue that shows only the orders that need a person, and says why. Each order page reads as a story, where every fact shows its source, time and evidence level.
- **Ringo:** a real LLM agent for pickup readiness. It reads first, rings the pickup site through a phone menu (simulated), can ask the assigned driver (simulated), and grades what it learns on the evidence ladder. Then it either finishes or stops with one clear decision for a person.
- **Grafts:**
  - Reconcile before retry.
  - A deterministic case-law Reviewer gate with a leave-one-out eval.
  - A trust ledger (auto / ask / never).
  - A "Since you left" handover strip.
  - CD-420322 as a non-agent "one decision" card.

## Read before you write code

1. `CONTRACT.md` covers the architecture, tables, tools, routes, demo orders and **file ownership**. Stay inside your lane.
2. `starter/lib/contract.ts` holds every shared type. Never edit it; ask the integrator.
3. `PARTICIPANT-BRIEF.md`, `OPERATIONS-CONTEXT.md` and `dataset/SCHEMA.md` describe the world. They explain the data better than the code does.
4. `starter/AGENTS.md`: this is Next.js 16, not the version you know. Read `starter/node_modules/next/dist/docs/` before using an API.

## Hard rules: NEVER violate

1. **Ringo never contacts a customer.** A customer is anyone who pays. Ringo may call pickup sites and pickup contacts, and message the order's assigned driver. It may not contact delivery recipients or customers. This is enforced in code (tool guards + gate rule CL-10), not only in the prompt.
2. **A person approves before anything changes a booking, a date, a cost, or sends a message to a customer.** These trust rows are locked to "ask" and can never be promoted. Asking questions and looking things up need no approval.
3. **No mechanical advice, no diagnosis, no blame.** Ringo never tells a driver to restart, reset or drive on. It never assigns fault from photos.
4. **A quote is not a booking, a booking is not a movement, and a claim is not a fact.** Every fact carries a level (`claimed / quoted / reserved / observed / verified / stale / refuted`). Code caps the level by source type, and Ringo may never write `verified`.
5. **Every fact shown in the UI has a source and a time.** A fact without a resolvable source id is dropped, never shown, and the same goes for handover sentences.
6. **Read before you dial; reconcile before you retry.** Ringo never redials after an unknown outcome (dropped call, timeout) without re-reading and stating what it found. It never retries a failed action blind.
7. **Recheck before write.** Every proposal records `dependency.basisEventId`. If the order changed before approval, execution is `STALE` and nothing changes.
8. **Prepare, don't cancel.** Ringo never cancels or double-books, and never represents a backup as booked.
9. **Synthetic data only.** Do not add real people, companies, phone numbers, addresses or messages. Sim numbers are `sim:<siteId>`. Sim people get fictional names in the dataset's style. Everything simulated is labelled "Simulated" in the UI.
10. **Never contact the outside world.** There are no real calls, emails, bookings or webhooks to real services. The only external calls are the Anthropic API and PostHog product analytics (decided 24 Oct; optional: with no `NEXT_PUBLIC_POSTHOG_*` env vars nothing is sent and the app must still run). Test traffic is tagged `synthetic_tester`.
11. **This is an ops tool, not a dev tool.**
    - Use plain words and no JSON on screen.
    - Show no model or token stats in the main UI.
    - Calm spacing, readable text.
    - Every panel has an empty state and a loading state.
    - Audio never autoplays.
    - Use the starter's birch/asphalt/sand palette and fonts.
12. **Never print, log or commit `ANTHROPIC_API_KEY`.** It is loaded from `starter/.env.local` (gitignored). When the key is empty, Ringo shows "offline" and offers Replay.
13. **Do not modify the dataset, the attachments or the starter's seed and schema.** Our tables live in `starter/lib/ring-schema.ts` with no foreign keys to starter tables.
14. **Do not git commit or push.** The integrator does.

## Environment

- **Node 24:** `export PATH=~/.local/node-v24.22.1-linux-x64/bin:$PATH` (the system node is 20).
- **Docker:** compose v1, so use `docker-compose` without `--wait`. Postgres is on `localhost:5438` (already seeded). RustFS is on 9009/9010.
- **App:** `cd starter && npm run dev` serves http://localhost:3000.
- **Checks:** `npm run typecheck`, `npm run build`, `APP_URL=http://localhost:3000 npm run smoke`.
- **Model:** `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`. Invoke the `claude-api` skill before writing SDK code.

## Code style

- Keep it lean. Prefer stdlib and native first: `fetch`, Web Streams, the browser's `speechSynthesis`/`SpeechRecognition`, and CSS. The only new dependency is `@anthropic-ai/sdk`.
- Reuse `starter/lib/present/*` (`loadOrder`, `loadBoardBundles`, `labels`, `time`) instead of re-querying.
- Deterministic logic (triage, gate, fact levels, validators) is plain code with one runnable `*.check.ts` self-check. The LLM decides only what to read, whom to call, what to ask, and how to phrase things.
- Write times as UTC ISO strings. Show local times with their zone name.
