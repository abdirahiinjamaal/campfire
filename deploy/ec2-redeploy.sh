#!/usr/bin/env bash
# Run on the EC2 instance after pushing changes: sudo bash /opt/campfire/deploy/ec2-redeploy.sh
set -euo pipefail

cd /opt/campfire
git pull --ff-only
/usr/local/go/bin/go build -trimpath -ldflags="-s -w" -o /usr/local/bin/campfire .
systemctl restart campfire
sleep 1
curl -fsS -o /dev/null -w "campfire redeployed: HTTP %{http_code}\n" http://127.0.0.1:8080/
