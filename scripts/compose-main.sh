#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example to .env and fill the required values first." >&2
  exit 1
fi

docker compose --env-file .env -f docker-compose.main.yml "$@"
