#!/usr/bin/env bash
# Wangpan storage-agent in-place updater.
#
# Use this when agent code has been bumped on GitHub and you want this
# already-installed node to pick up the new version. Preserves the existing
# .env (so AGENT_TOKEN / NODE_ID stay the same — re-running the *install*
# script would generate a new token and disconnect the node from the main VPS).
#
# Usage (interactive, recommended):
#   curl -fsSL https://raw.githubusercontent.com/ftweg2/jiedian-pan/main/scripts/update-storage-agent.sh | sudo bash
#
# Usage (existing checkout, scripted):
#   sudo REPO_DIR=/opt/wangpan-storage-agent bash update-storage-agent.sh
#
# What this does:
#   1. cd into the existing repo (default /opt/wangpan-storage-agent).
#   2. git fetch + reset --hard origin/HEAD (so you're matching what's on GitHub).
#   3. docker compose up -d --build  — rebuilds the agent image, then restarts
#      the container with zero data loss (the bind-mounted /data/objects volume
#      is untouched).
#   4. Waits for /health to come back up.
#
# Stuff that's NOT touched:
#   - .env (AGENT_TOKEN, NODE_ID stay the same — your main VPS keeps working)
#   - docker-compose.agent.override.yml (port + data dir from install time)
#   - /srv/wangpan-agent-data (or wherever your AGENT_DATA_DIR points)
#
# If something breaks, roll back with:
#   git -C /opt/wangpan-storage-agent reset --hard HEAD@{1}
#   docker compose -f docker-compose.agent.yml -f docker-compose.agent.override.yml up -d --build

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/wangpan-storage-agent}"

say()  { printf '\033[1;32m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (or via sudo)."
[ -d "$REPO_DIR/.git" ] || die "$REPO_DIR is not a git checkout. Did you install with install-storage-agent.sh?"
[ -f "$REPO_DIR/.env" ] || die "$REPO_DIR/.env is missing — refusing to continue (would lose AGENT_TOKEN)."

cd "$REPO_DIR"

OLD_SHA=$(git rev-parse --short HEAD)
say "Current revision: $OLD_SHA"

say "Fetching latest from origin…"
git fetch --depth 1 origin
NEW_SHA=$(git rev-parse --short origin/HEAD)

if [ "$OLD_SHA" = "$NEW_SHA" ]; then
  say "Already up to date ($OLD_SHA). Nothing to do."
  exit 0
fi

say "Updating $OLD_SHA → $NEW_SHA"
git reset --hard origin/HEAD

# Show what actually changed for the agent (so you know if the rebuild is
# necessary or just churn in unrelated code).
echo
say "Agent / storage-driver changes in this update:"
git log --oneline "$OLD_SHA..HEAD" -- apps/storage-agent/ packages/storage-driver/ || true
echo

# If neither agent nor driver changed, we can skip the rebuild entirely.
if [ -z "$(git log --oneline "$OLD_SHA..HEAD" -- apps/storage-agent/ packages/storage-driver/)" ]; then
  warn "No agent or driver code changed in this update — skipping rebuild."
  say "Done. Repo is at $NEW_SHA but the container wasn't touched."
  exit 0
fi

say "Rebuilding + restarting agent container (this can take 2–5 minutes)…"
docker compose --env-file .env \
  -f docker-compose.agent.yml \
  -f docker-compose.agent.override.yml \
  up -d --build

# Pick AGENT_PORT out of the override so the health check uses the right port.
AGENT_PORT=$(awk -F'[":]' '/^[[:space:]]+- "/{print $3; exit}' docker-compose.agent.override.yml || echo 4010)
[ -n "$AGENT_PORT" ] || AGENT_PORT=4010

say "Waiting for /health on port $AGENT_PORT…"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$AGENT_PORT/health" >/dev/null 2>&1; then
    say "Agent is live on $NEW_SHA."
    exit 0
  fi
  sleep 2
done
die "Agent didn't pass /health within 60s — check 'docker compose logs storage-agent' and consider rolling back."
