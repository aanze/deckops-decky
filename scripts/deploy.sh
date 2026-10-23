#!/usr/bin/env bash
# Build and install the plugin on a Decky device over SSH.
#   scripts/deploy.sh [user@host]   (default: armada@192.168.1.26)
# Decky keeps ~/homebrew/plugins owned by root, so the last step asks for the
# device user's sudo password.
set -euo pipefail
cd "$(dirname "$0")/.."
DEVICE="${1:-armada@192.168.1.26}"
NAME="tailscale-toggle"

pnpm build
ssh "$DEVICE" "rm -rf /tmp/$NAME && mkdir -p /tmp/$NAME/dist"
scp -q main.py plugin.json package.json LICENSE README.md "$DEVICE:/tmp/$NAME/"
scp -q dist/index.js dist/index.js.map "$DEVICE:/tmp/$NAME/dist/"
ssh -t "$DEVICE" "sudo rm -rf ~/homebrew/plugins/$NAME \
  && sudo cp -r /tmp/$NAME ~/homebrew/plugins/$NAME \
  && sudo chown -R root:root ~/homebrew/plugins/$NAME \
  && echo 'Installed. Decky picks it up on its own; if not, restart it:' \
  && echo '  sudo systemctl restart plugin_loader'"
