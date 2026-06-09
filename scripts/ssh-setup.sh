#!/usr/bin/env bash
# Generates an SSH key pair for homebridge deployment and configures ~/.ssh/config.
# Usage: ./scripts/ssh-setup.sh <pi-host> [pi-user]

set -euo pipefail

HOST="${1:?Usage: $0 <pi-host> [pi-user]}"
USER="${2:-pi}"
KEY_NAME="homebridge_deploy"
KEY_PATH="$HOME/.ssh/$KEY_NAME"

if [[ ! -f "$KEY_PATH" ]]; then
  echo "Generating SSH key pair at $KEY_PATH ..."
  ssh-keygen -t ed25519 -C "homebridge-deploy" -f "$KEY_PATH" -N ""
else
  echo "Key $KEY_PATH already exists, skipping generation."
fi

echo "Copying public key to $USER@$HOST ..."
ssh-copy-id -i "${KEY_PATH}.pub" "$USER@$HOST"

# Add SSH config entry if not already present
CONFIG_BLOCK="Host homebridge\n  HostName $HOST\n  User $USER\n  IdentityFile $KEY_PATH\n  ServerAliveInterval 60"

if ! grep -q "Host homebridge" "$HOME/.ssh/config" 2>/dev/null; then
  echo "Adding homebridge entry to ~/.ssh/config ..."
  printf "\n%b\n" "$CONFIG_BLOCK" >> "$HOME/.ssh/config"
  chmod 600 "$HOME/.ssh/config"
else
  echo "~/.ssh/config already has a homebridge entry, skipping."
fi

echo ""
echo "Done. Connect with: ssh homebridge"
