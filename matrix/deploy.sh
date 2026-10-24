#!/usr/bin/env bash
# Deploy Ringo (bahn-ring) to your Matrix OS computer. This is the procedure that ran on 24 Oct 2026.
# DRY RUN BY DEFAULT: prints every remote step. Add --apply to do it (uses the logged-in `matrix` CLI).
#
#   matrix/deploy.sh            # dry run
#   matrix/deploy.sh --apply    # deploy committed HEAD; secrets come from ../.env and starter/.env.local
#
# What it does on the box:
#   1. git archive HEAD -> 4 MB chunks (the upload API rejects ~18 MB in one go) -> ~/projects/bahn-ring
#   2. starter/.env.local (Anthropic key, PostHog, DB, NEXT_BASE_PATH) uploaded with --secret; never printed
#   3. Postgres 17 + RustFS as plain `docker run` containers (the box has docker but no compose)
#   4. npm ci, db:push, seed, attachments:seed, build with basePath /apps/bahn-ring (detached; log in ~/projects/bahn-setup.log)
#   5. ~/apps/bahn-ring/matrix.json -> Matrix starts matrix/prefix-proxy.mjs, which re-adds the /apps/bahn-ring
#      prefix the gateway strips, in front of `next start`. Open it from the Matrix desktop.
#   6. Ringo's background agent loop, supervised (log in ~/projects/bahn-loop.log)
# Note: `matrix run` needs `-C .` (CLI 0.3.22 sends an empty cwd otherwise and the gateway answers 400).
set -euo pipefail
APPLY=0; [[ ${1:-} == --apply ]] && APPLY=1
REPO=$(cd "$(dirname "$0")/.." && pwd)
HACK=$(dirname "$REPO")
run() { if ((APPLY)); then "$@"; else printf '[dry-run]'; printf ' %q' "$@"; echo; fi; }
box() { run matrix run -C . -- sh -c "$1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
git -C "$REPO" archive --prefix=bahn-ring/ -o "$TMP/bahn-ring.tgz" HEAD
(cd "$TMP" && split -b 4M -d bahn-ring.tgz part.)
echo "packed HEAD: $(du -h "$TMP/bahn-ring.tgz" | cut -f1), $(ls "$TMP"/part.* | wc -l) chunks"

( umask 077
  { grep -E '^ANTHROPIC_(API_KEY|MODEL)=' "$HACK/.env" || true
    grep -E '^NEXT_PUBLIC_POSTHOG_' "$REPO/starter/.env.local" 2>/dev/null || true
    grep -E '^(DATABASE_URL|S3_)' "$REPO/starter/.env.example"
    echo NEXT_BASE_PATH=/apps/bahn-ring; } > "$TMP/env.local" )
echo "secrets file keys: $(cut -d= -f1 "$TMP/env.local" | tr '\n' ' ')"

for p in "$TMP"/part.*; do run matrix upload --force "$p" "projects/_up/bahn-ring.$(basename "$p")"; done
box 'cd projects && cat _up/bahn-ring.part.* > b.tgz && rm -rf _up bahn-ring && tar xzf b.tgz && rm b.tgz'
run matrix upload --force --secret "$TMP/env.local" projects/bahn-ring/starter/.env.local

box 'docker start bahn-db 2>/dev/null || docker run -d --name bahn-db --restart unless-stopped -e POSTGRES_USER=controlroom -e POSTGRES_PASSWORD=controlroom -e POSTGRES_DB=controlroom -p 127.0.0.1:5438:5432 -v bahn_pg:/var/lib/postgresql/data postgres:17-alpine
docker start bahn-files 2>/dev/null || docker run -d --name bahn-files --restart unless-stopped -e RUSTFS_ACCESS_KEY=controlroom -e RUSTFS_SECRET_KEY=controlroom-local-only -e RUSTFS_ADDRESS=0.0.0.0:9000 -p 127.0.0.1:9009:9000 -v bahn_files:/data rustfs/rustfs:1.0.1 /data'

box 'cd projects/bahn-ring/starter && setsid nohup sh -c "set -e; set -a; . ./.env.local; set +a; npm ci --no-audit --no-fund; for i in \$(seq 30); do npm run -s db:push && break; sleep 2; done; npm run db:seed; npm run attachments:seed; npm run build; echo SETUP_DONE" > ../../bahn-setup.log 2>&1 < /dev/null &'
echo "wait for SETUP_DONE:  matrix run -C . -- tail -3 projects/bahn-setup.log"

run matrix upload --force "$REPO/matrix/matrix.json" apps/bahn-ring/matrix.json

# 6. Ringo's background agent: triage every 5 min, due callbacks every minute, and (--autorun) a first
#    live run on orders Ringo can call but never has (max 2 per pass). A shell supervisor restarts it;
#    `bahn-ring-loop` in its argv lets the next deploy stop the old one. Log: ~/projects/bahn-loop.log
box 'pkill -f "[b]ahn-ring-loop"; pkill -f "[s]cripts/background.ts"; true'  # separate call: the start command below names the loop, so pkill would match its own shell
box 'cd projects/bahn-ring/starter && setsid nohup sh -c "while true; do npm run -s ring:background -- --loop --autorun; sleep 30; done" bahn-ring-loop >> ../../bahn-loop.log 2>&1 < /dev/null &'
((APPLY)) || echo "(dry run: nothing was sent. Re-run with --apply.)"
