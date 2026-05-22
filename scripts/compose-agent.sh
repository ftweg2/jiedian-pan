#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Missing .env. Create a persistent .env with NODE_ID and AGENT_TOKEN first." >&2
  exit 1
fi

docker compose --env-file .env -f docker-compose.agent.yml "$@"
