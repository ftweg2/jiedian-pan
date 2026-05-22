#!/usr/bin/env bash
# Wangpan storage-agent one-shot installer for a fresh VPS.
#
# Use case: you already have a "main" Wangpan deployment somewhere, and you want
# to add THIS box as another storage node so that uploaded chunks can be spread
# across nodes when one fills up.
#
# Usage (interactive, recommended for first run):
#   curl -fsSL https://raw.githubusercontent.com/ftweg2/jiedian-pan/main/scripts/install-storage-agent.sh | sudo bash
#
# Usage (non-interactive, scripted):
#   sudo NODE_ID=remote-vps-1 AGENT_PORT=4010 \
#        AGENT_DATA_DIR=/srv/wangpan-agent-data \
#        bash install-storage-agent.sh
#
# Optional env overrides:
#   NODE_ID            unique identifier, will match what you enter on the main UI
#                      (default: hostname)
#   AGENT_PORT         port the agent listens on (default: 4010)
#   AGENT_TOKEN        bearer token, also saved in .env
#                      (default: openssl rand -base64 32)
#   AGENT_DATA_DIR     host directory bind-mounted to /data/objects
#                      (default: /srv/wangpan-agent-data)
#   AGENT_MAX_OBJECT_BYTES  per-object upload cap (default: 1 GiB)
#   REPO_URL           git URL to clone (default: hardcoded to your GitHub)
#   REPO_DIR           where to clone (default: /opt/wangpan-storage-agent)
#
# What this script does:
#   1. Verifies it's running as root (or with sudo).
#   2. Installs Docker engine + compose plugin if missing.
#   3. Clones the wangpan repo (so we can build the agent image locally).
#   4. Generates a random AGENT_TOKEN if not provided.
#   5. Writes a self-contained .env for docker-compose.agent.yml.
#   6. Builds + starts the agent container.
#   7. Verifies /health and prints the credentials you need to paste into
#      the main VPS's "Add Storage Node" form.

set -euo pipefail

# -------- defaults --------
DEFAULT_REPO_URL="https://github.com/ftweg2/jiedian-pan.git"
DEFAULT_REPO_DIR="/opt/wangpan-storage-agent"

NODE_ID="${NODE_ID:-$(hostname | tr -cd '[:alnum:]-' | head -c 32)}"
AGENT_PORT="${AGENT_PORT:-4010}"
AGENT_TOKEN="${AGENT_TOKEN:-}"
AGENT_DATA_DIR="${AGENT_DATA_DIR:-/srv/wangpan-agent-data}"
AGENT_MAX_OBJECT_BYTES="${AGENT_MAX_OBJECT_BYTES:-1073741824}"
REPO_URL="${REPO_URL:-$DEFAULT_REPO_URL}"
REPO_DIR="${REPO_DIR:-$DEFAULT_REPO_DIR}"

# -------- helpers --------
say() { printf '\033[1;32m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "Run as root (or via sudo)."
  fi
}

ensure_command() {
  command -v "$1" >/dev/null 2>&1
}

install_docker() {
  if ensure_command docker; then
    say "Docker already installed: $(docker --version)"
    return
  fi
  say "Installing Docker…"
  if ensure_command apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    if [ ! -s /etc/apt/keyrings/docker.gpg ]; then
      curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "${ID}")/gpg \
        | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
    fi
    chmod a+r /etc/apt/keyrings/docker.gpg
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
      | tee /etc/apt/sources.list.d/docker.list >/dev/null
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif ensure_command dnf; then
    dnf install -y dnf-plugins-core
    dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif ensure_command yum; then
    yum install -y yum-utils
    yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    die "Unsupported package manager. Install Docker manually then re-run."
  fi
  systemctl enable --now docker
  say "Docker installed."
}

ensure_token() {
  if [ -z "$AGENT_TOKEN" ]; then
    if ! ensure_command openssl; then
      ensure_command apt-get && apt-get install -y openssl || die "openssl required"
    fi
    AGENT_TOKEN="$(openssl rand -base64 32 | tr -d '=\n/+' | head -c 44)"
    say "Generated AGENT_TOKEN (${#AGENT_TOKEN} chars)."
  fi
}

clone_or_update_repo() {
  if [ -d "$REPO_DIR/.git" ]; then
    say "Repo already at $REPO_DIR — pulling latest."
    git -C "$REPO_DIR" fetch --depth 1 origin || true
    git -C "$REPO_DIR" reset --hard origin/HEAD || true
  else
    say "Cloning $REPO_URL → $REPO_DIR"
    git clone --depth 1 "$REPO_URL" "$REPO_DIR"
  fi
}

write_env() {
  mkdir -p "$AGENT_DATA_DIR"
  chown 1000:1000 "$AGENT_DATA_DIR" 2>/dev/null || true
  cat > "$REPO_DIR/.env" <<EOF
# Auto-generated by install-storage-agent.sh on $(date -Iseconds)
NODE_ID=$NODE_ID
AGENT_TOKEN=$AGENT_TOKEN
AGENT_MAX_OBJECT_BYTES=$AGENT_MAX_OBJECT_BYTES
EOF
  chmod 600 "$REPO_DIR/.env"
  say "Wrote $REPO_DIR/.env"
}

write_compose_override() {
  # Patch docker-compose.agent.yml port + data-volume binding via an override.
  # We don't touch the upstream compose file so future git pulls stay clean.
  cat > "$REPO_DIR/docker-compose.agent.override.yml" <<EOF
services:
  storage-agent:
    ports:
      - "$AGENT_PORT:4010"
    volumes:
      - $AGENT_DATA_DIR:/data/objects
EOF
  say "Wrote $REPO_DIR/docker-compose.agent.override.yml (port $AGENT_PORT, data $AGENT_DATA_DIR)"
}

start_agent() {
  cd "$REPO_DIR"
  say "Building + starting agent (this can take 2–5 minutes)…"
  docker compose --env-file .env \
    -f docker-compose.agent.yml \
    -f docker-compose.agent.override.yml \
    up -d --build
  say "Waiting for /health to come up…"
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$AGENT_PORT/health" >/dev/null 2>&1; then
      say "Agent is live."
      return
    fi
    sleep 2
  done
  die "Agent didn't pass /health within 60s — check 'docker compose logs storage-agent'."
}

print_summary() {
  local public_ip
  public_ip="$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || echo 'PUBLIC_IP_LOOKUP_FAILED')"
  local internal_ip
  internal_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"

  cat <<EOF

============================================================
  Wangpan storage-agent installed.
============================================================
  Node ID:           $NODE_ID
  Listen port:       $AGENT_PORT
  Data dir:          $AGENT_DATA_DIR
  Internal IP:       $internal_ip
  Public IP:         $public_ip

  AGENT_TOKEN (paste this on the main VPS when adding the node):
    $AGENT_TOKEN

  Base URL to enter on the main VPS:
    • Same private network (VPC / WireGuard):
        http://$internal_ip:$AGENT_PORT
    • Across public Internet (NOT recommended without TLS):
        http://$public_ip:$AGENT_PORT

  Verify locally on THIS box:
    curl http://127.0.0.1:$AGENT_PORT/health
    curl -H "Authorization: Bearer $AGENT_TOKEN" http://127.0.0.1:$AGENT_PORT/status

  Open the firewall on the chosen interface:
    sudo ufw allow from <MAIN_VPS_IP> to any port $AGENT_PORT proto tcp
    # or with iptables / cloud security group equivalent

  Then on the main VPS web UI → 节点 → 添加节点:
    Name:    $NODE_ID
    BaseURL: http://<reachable IP>:$AGENT_PORT
    Token:   $AGENT_TOKEN
============================================================
EOF
}

# -------- main --------
main() {
  require_root
  install_docker
  ensure_command git || (apt-get install -y git 2>/dev/null || dnf install -y git 2>/dev/null || yum install -y git 2>/dev/null) || die "git required"
  ensure_command curl || (apt-get install -y curl 2>/dev/null || dnf install -y curl 2>/dev/null || yum install -y curl 2>/dev/null) || die "curl required"
  ensure_token
  clone_or_update_repo
  write_env
  write_compose_override
  start_agent
  print_summary
}

main "$@"
