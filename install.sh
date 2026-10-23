#!/bin/sh
# Install (or update) DeckOps on a Decky device. Run it ON the device:
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/aanze/deckops-decky/main/install.sh)"
set -eu

URL="https://github.com/aanze/deckops-decky/releases/latest/download/deckops.zip"
PLUGINS="$HOME/homebrew/plugins"
NAME="deckops"

[ -d "$PLUGINS" ] || { echo "Decky Loader not found ($PLUGINS missing)."; exit 1; }
command -v tailscale >/dev/null || echo "Warning: 'tailscale' is not installed; the Tailscale card will show 'not installed'."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading latest release..."
curl -fsSL "$URL" -o "$TMP/plugin.zip"
unzip -q -o "$TMP/plugin.zip" -d "$TMP"

echo "Installing to $PLUGINS/$NAME (sudo needed: Decky keeps this folder root-owned)"
sudo rm -rf "$PLUGINS/$NAME"
sudo mv "$TMP/$NAME" "$PLUGINS/$NAME"
sudo chown -R root:root "$PLUGINS/$NAME"

echo "Done. Open the Quick Access Menu (... button) - Decky loads new plugins on its own."
echo "If it does not show up: sudo systemctl restart plugin_loader"
