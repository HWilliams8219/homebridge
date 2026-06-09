#!/usr/bin/env bash
# Deploys the homebridge build to a remote Pi over SSH.
# Requires ssh-setup.sh to have been run first (or equivalent SSH access).
# Usage: ./scripts/ssh-deploy.sh [pi-host] [pi-user] [remote-path]

set -euo pipefail

HOST="${1:-homebridge}"           # defaults to the SSH alias created by ssh-setup.sh
USER="${2:-pi}"
REMOTE_PATH="${3:-/usr/local/lib/homebridge}"

echo "Building ..."
npm run build

echo "Deploying dist/ to $USER@$HOST:$REMOTE_PATH ..."
rsync -avz --delete \
  --exclude 'node_modules' \
  dist/ \
  "$USER@$HOST:$REMOTE_PATH/"

echo "Restarting homebridge service ..."
ssh "$USER@$HOST" "sudo systemctl restart homebridge"

echo "Deploy complete."
