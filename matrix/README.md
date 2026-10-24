## Running Ringo on Matrix OS

Ringo can run on an always-on [Matrix OS](https://github.com/HamedMP/matrix-os) box, so triage keeps going with the laptop closed.

| piece | file | what it does |
|---|---|---|
| App manifest | `matrix/matrix.json` | Puts Ringo in the Matrix launcher (`~/apps/bahn-ring/`, node runtime, `next start -p $PORT`) |
| Cron entry | `matrix/cron.json` | A Matrix cron job at 07:00 Helsinki time that tells the operator's Telegram the handover is coming |
| Box loop | `matrix/box-loop.mjs` | Every 5 min it runs triage and due callbacks (`scripts/background.ts`, or `POST /api/agent/jobs/run-due` if that file is missing). At 07:00 it posts the live "Since you left" handover to Telegram through Matrix |
| Deploy | `matrix/deploy.sh` | Packs the repo, uploads it to `~/projects/bahn-ring`, seeds, builds, and registers the app and cron. **Dry run unless `--apply`** |

```bash
matrix/deploy.sh                         # see the plan; nothing is sent
matrix/deploy.sh --apply --secrets=FILE  # FILE: ANTHROPIC_API_KEY, MATRIX_TOKEN, TELEGRAM_CHAT_ID
node matrix/box-loop.mjs --check         # self-test of the clock logic
```

**Why a loop and not only Matrix cron:** a Matrix cron job delivers a fixed text to a channel. It does not run commands (see `packages/gateway/src/server.ts`, the cron `onTrigger`). So the 5-minute clock lives in `box-loop.mjs`. Telegram delivery is still done by Matrix: the loop adds a one-shot cron job with the handover text, which Matrix sends and then deletes.

**Telegram is off by default.** It is on only when `MATRIX_TOKEN` and `TELEGRAM_CHAT_ID` are set, and goes only to the operator's own chat. It carries the handover sentences with their source ids and nothing addressed to a customer.

To watch it from a laptop, run `matrix port forward 3000` and open http://localhost:3000/apps/bahn-ring. Matrix serves apps under `/apps/<slug>`, like its own Next template (`basePath: /apps/${MATRIX_APP_SLUG}`), so the box builds and starts with `NEXT_BASE_PATH=/apps/bahn-ring`: Next's `basePath`, plus `withBase()` (`starter/lib/base.ts`) for raw `fetch`, `<img>` and `<a>` URLs. Locally `NEXT_BASE_PATH` is unset and nothing changes. Checked with a local `next build && next start` under the prefix (pages, assets and API calls all load); not tested on a real box yet.
