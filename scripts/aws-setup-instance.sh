#!/usr/bin/env bash
# Set up a fresh Ubuntu 24.04 EC2 instance for Grover.
# Run this ON the EC2 instance after SSHing in.
#
# Usage:
#   ./aws-setup-instance.sh --domain grover.example.com --repo git@github.com:user/grover.git [options]
#
# Options:
#   --domain DOMAIN       Domain for Caddy HTTPS (required)
#   --repo URL            Git repo URL to clone (required)
#   --auth-domain DOMAIN  Separate Keycloak domain (default: auth.<domain>)
#   --branch BRANCH       Git branch to deploy (default: main)
#   --skip-bootstrap      Don't run database bootstrap

set -euo pipefail

DOMAIN=""
AUTH_DOMAIN=""
REPO=""
BRANCH="main"
SKIP_BOOTSTRAP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)       DOMAIN="$2"; shift 2 ;;
    --auth-domain)  AUTH_DOMAIN="$2"; shift 2 ;;
    --repo)         REPO="$2"; shift 2 ;;
    --branch)       BRANCH="$2"; shift 2 ;;
    --skip-bootstrap) SKIP_BOOTSTRAP=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" || -z "$REPO" ]]; then
  echo "Usage: $0 --domain grover.example.com --repo <git-url> [options]"
  exit 1
fi

AUTH_DOMAIN="${AUTH_DOMAIN:-auth.${DOMAIN}}"

echo "=== Grover Instance Setup ==="
echo "  Domain:      $DOMAIN"
echo "  Auth domain: $AUTH_DOMAIN"
echo "  Repo:        $REPO ($BRANCH)"
echo ""

# ── 1. Install Docker ──
echo "[1/6] Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo "  Docker installed. You may need to log out and back in for group changes."
else
  echo "  Docker already installed."
fi

# Install Docker Compose plugin if missing
if ! docker compose version &>/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-compose-plugin
fi
echo "  Docker Compose: $(docker compose version --short 2>/dev/null || echo 'installed')"

# ── 2. Install Caddy ──
echo "[2/6] Installing Caddy..."
if ! command -v caddy &>/dev/null; then
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
else
  echo "  Caddy already installed."
fi

# ── 3. Clone repository ──
echo "[3/6] Cloning repository..."
if [[ ! -d "$HOME/grover" ]]; then
  git clone --branch "$BRANCH" "$REPO" "$HOME/grover"
else
  echo "  ~/grover already exists, pulling latest..."
  cd "$HOME/grover"
  git fetch origin
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
fi
cd "$HOME/grover"

# Pull corpus and seed from S3 if bucket is configured
if [[ -n "${GROVER_S3_BUCKET:-}" ]]; then
  echo "  Pulling corpus and seed from S3..."
  ./scripts/s3-sync.sh pull-corpus
  ./scripts/s3-sync.sh pull-seed
fi

# ── 4. Create .env if missing ──
echo "[4/6] Configuring environment..."
if [[ ! -f .env ]]; then
  PG_PASS=$(openssl rand -hex 16)
  KC_PASS=$(openssl rand -hex 16)
  API_KEY=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || openssl rand -hex 16)

  cat > .env << ENVEOF
# ── LLM Configuration ──
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# ── AWS Polly TTS ──
AWS_REGION=ap-southeast-2
POLLY_VOICE=Olivia
POLLY_ENGINE=neural

# ── Keycloak OIDC ──
KEYCLOAK_URL=http://keycloak:8080
KEYCLOAK_PUBLIC_URL=https://${AUTH_DOMAIN}
KEYCLOAK_REALM=grover
KEYCLOAK_CLIENT_ID=grover-web
KEYCLOAK_ADMIN_USER=admin
KEYCLOAK_ADMIN_PASSWORD=${KC_PASS}

# ── API Key Authentication ──
GROVER_API_KEY=${API_KEY}

# ── CORS ──
CORS_ORIGIN=https://${DOMAIN}

# ── PostgreSQL ──
POSTGRES_PASSWORD=${PG_PASS}
DATABASE_URL=postgres://grover:${PG_PASS}@postgres:5432/grover
ENVEOF

  echo "  Created .env with generated passwords."
  echo ""
  echo "  IMPORTANT: Edit .env to add your OPENAI_API_KEY:"
  echo "    nano ~/grover/.env"
  echo ""
  echo "  Generated credentials:"
  echo "    PostgreSQL password: ${PG_PASS}"
  echo "    Keycloak admin:     ${KC_PASS}"
  echo "    API key:            ${API_KEY}"
  echo ""
else
  echo "  .env already exists, skipping."
fi

# ── 5. Start Docker Compose ──
echo "[5/6] Starting Docker Compose..."

# Ensure current user can run docker (newgrp avoids re-login)
if ! docker ps &>/dev/null 2>&1; then
  echo "  Running docker commands via sudo (re-login for group changes to take effect)."
  DOCKER_CMD="sudo docker compose"
else
  DOCKER_CMD="docker compose"
fi

cd "$HOME/grover"
$DOCKER_CMD up -d

echo "  Waiting for services to be healthy..."
sleep 15

# Wait for health check
for i in $(seq 1 24); do
  if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo "  Grover is healthy."
    break
  fi
  if [[ $i -eq 24 ]]; then
    echo "  WARNING: Health check not passing yet. Check logs with: docker compose logs"
  fi
  sleep 5
done

# Bootstrap database from seed if available
if [[ "$SKIP_BOOTSTRAP" == "false" ]]; then
  if [[ -f config/grover-seed.dump ]]; then
    echo "  Bootstrapping database from seed dump..."
    $DOCKER_CMD run --rm grover bootstrap
  else
    echo "  No seed dump found (config/grover-seed.dump). Skipping bootstrap."
    echo "  Run 'docker compose run --rm grover ingest --index <name>' to build an index."
  fi
fi

# ── 6. Configure Caddy + systemd ──
echo "[6/6] Configuring Caddy and systemd..."

sudo tee /etc/caddy/Caddyfile > /dev/null << CADDYEOF
${DOMAIN} {
    reverse_proxy localhost:3000
}

${AUTH_DOMAIN} {
    reverse_proxy localhost:8080
}
CADDYEOF

sudo systemctl restart caddy
sudo systemctl enable caddy

# Set up systemd service for Docker Compose auto-start
sudo cp "$HOME/grover/config/grover.service" /etc/systemd/system/grover.service
sudo systemctl daemon-reload
sudo systemctl enable grover

# Set up daily backup cron (if aws cli is available)
if command -v aws &>/dev/null; then
  echo "  Setting up daily backup cron..."
  CRON_LINE="0 2 * * * $HOME/grover/scripts/aws-backup.sh >> /var/log/grover-backup.log 2>&1"
  (crontab -l 2>/dev/null | grep -v aws-backup.sh; echo "$CRON_LINE") | crontab -
  echo "  Daily backup at 2:00 AM UTC configured."
else
  echo "  AWS CLI not found — skipping backup cron."
  echo "  Install with: sudo apt-get install awscli && aws configure"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "  Grover:   https://${DOMAIN}"
echo "  Keycloak: https://${AUTH_DOMAIN}"
echo "  Health:   https://${DOMAIN}/health"
echo ""
echo "  Logs:     cd ~/grover && docker compose logs -f"
echo "  Restart:  sudo systemctl restart grover"
echo ""
echo "  DNS: Point ${DOMAIN} and ${AUTH_DOMAIN} to this instance's Elastic IP."
echo ""
if ! curl -sf http://localhost:3000/health > /dev/null 2>&1; then
  echo "  NOTE: Health check is not yet passing. Give services a minute to start."
  echo "        Check status with: docker compose ps && docker compose logs"
fi
