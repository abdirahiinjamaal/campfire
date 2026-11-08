#!/usr/bin/env bash
set -euo pipefail

if [ ! -f "$HOME/campfire-linux" ]; then
  echo "campfire-linux not found in $HOME" >&2
  exit 1
fi

sudo install -m 755 "$HOME/campfire-linux" /usr/local/bin/campfire

sudo tee /etc/systemd/system/campfire.service >/dev/null <<'EOF'
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

sudo systemctl daemon-reload
sudo systemctl enable --now campfire
sleep 1
sudo systemctl --no-pager --lines=5 status campfire || true
curl -fsS -o /dev/null -w "local check: HTTP %{http_code}\n" http://127.0.0.1:8080/
