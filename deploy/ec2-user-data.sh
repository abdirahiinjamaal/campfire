#!/bin/bash
# campfire EC2 user data (Ubuntu 24.04, x86 or ARM)
# BEFORE PASTING: replace YOUR_USER below with your GitHub username.
set -euo pipefail

REPO_URL="https://github.com/YOUR_USER/campfire.git"
APP_DIR="/opt/campfire"
BIN="/usr/local/bin/campfire"

exec > >(tee -a /var/log/campfire-setup.log) 2>&1
echo "==> campfire setup started at $(date -u +%FT%TZ)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates

ARCH="$(dpkg --print-architecture)"
GO_VERSION="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -n1)"
echo "==> installing ${GO_VERSION} for ${ARCH}"
curl -fsSL "https://go.dev/dl/${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tar.gz
rm -rf /usr/local/go
tar -C /usr/local -xzf /tmp/go.tar.gz
rm -f /tmp/go.tar.gz
ln -sf /usr/local/go/bin/go /usr/local/bin/go
go version

echo "==> cloning ${REPO_URL}"
rm -rf "$APP_DIR"
git clone --depth 1 "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

echo "==> building campfire"
go build -trimpath -ldflags="-s -w" -o "$BIN" .
chmod 755 "$BIN"

cat >/etc/systemd/system/campfire.service <<'EOF'
[Unit]
Description=campfire drum circle
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/campfire
Environment=ADDR=:8080
Restart=always
RestartSec=2
DynamicUser=yes
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now campfire
sleep 1
systemctl --no-pager --lines=5 status campfire || true
curl -fsS -o /dev/null -w "==> local check: HTTP %{http_code}\n" http://127.0.0.1:8080/

TOKEN="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
IP="$(curl -fsS -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/public-ipv4 || true)"
echo "==> done. Open http://${IP:-<instance-public-ip>}:8080"
