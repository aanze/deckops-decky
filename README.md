# DeckOps for Decky

A [Decky Loader](https://decky.xyz) plugin for handhelds that double as a
small home server. From the Quick Access Menu it lets you:

- **Toggle [Tailscale](https://tailscale.com)** and see your tailnet: state,
  tailnet IP, DNS name, the other machines and whether they are online.
- **Start and stop services** running on the device (by default the
  [OpenClaw](https://openclaw.ai) gateway) and publish them to your tailnet
  over Tailscale Serve, so you reach them from your phone.
- **Chat with the on-device agent** without leaving game mode: a small chat
  box talks to the OpenClaw gateway on loopback, streaming replies.

Written for an **AYN Odin 3 running [Armada](https://github.com/armada-os/armada)**
(immutable Fedora image, Tailscale CLI without a GUI), but nothing is
Armada-specific: it needs a Linux device with Decky Loader, `systemd`, and
`tailscale`/`tailscaled` for the network part.

The backend runs as root (Decky `root` flag) because talking to `tailscaled`
requires it. Everything else it does, it does as root too, so read the
[Security notes](#security-notes).

## What it does

- **Tailscale toggle** — `tailscale up` / `tailscale down`. If `tailscaled`
  is not running it is started first. Turning it off keeps the daemon alive
  so the next "on" is instant. The status card shows Connected / Disconnected
  / Not logged in / Daemon stopped, IPv4, DNS name, account; press A on it to
  refresh.
- **Devices** — every peer on the tailnet, online ones first, with OS and IP.
- **Services** — one card per entry in `services.json` (see below): an
  *Enabled* toggle (start/stop the systemd unit), a *Start at boot* toggle
  (enable/disable it), the state with a readiness probe on the service port,
  and the URL to use: `https://<device>.<tailnet>.ts.net/` when Tailscale is
  up and the port is served, the local one otherwise.
- **Chat** — shown under a running service that has a `chat` entry. Type a
  message (the Steam on-screen keyboard opens on the text field), *Send*, and
  the reply streams in. *Stop* aborts the current reply, *New session* starts
  a fresh agent session. The conversation stays while the plugin is loaded,
  even when the panel is closed.
- Polls every 4 s while the panel is open, nothing runs when it is closed.

## Services

Services live in `~/homebrew/settings/deckops/services.json`, written with
this default on first run:

```json
[
  {
    "id": "openclaw",
    "label": "OpenClaw",
    "unit": "openclaw-gateway.service",
    "scope": "user",
    "port": 18789,
    "serve": true,
    "local_url": "http://127.0.0.1:18789",
    "chat": {
      "base_url": "http://127.0.0.1:18789",
      "token_file": "~/.openclaw/openclaw.json",
      "model": "openclaw"
    }
  }
]
```

- `scope` — `user` for a `systemd --user` unit of the logged-in user (the
  backend reaches it from root with `systemctl --user -M <user>@`), `system`
  for a system unit.
- `port` — probed on 127.0.0.1 to show *Running* only once the service really
  answers (OpenClaw takes 10–30 s to come up).
- `serve` — when the service is running and Tailscale is up, the plugin runs
  `tailscale serve --bg http://127.0.0.1:<port>`, which publishes it as
  `https://<device>.<tailnet>.ts.net/` to your tailnet only. The Serve config
  persists across `tailscale up/down`, so this only has to succeed once. It
  needs **Serve and HTTPS enabled on your tailnet**: the first attempt shows a
  toast with the Tailscale link that enables both; until then the service
  stays reachable locally. The device user must be the Tailscale operator
  (`sudo tailscale set --operator=<user>`).
- `chat` — an OpenAI-compatible `/v1/chat/completions` endpoint. `token_file`
  is read by the backend to get the bearer token (`gateway.auth.token` for
  OpenClaw); `model` is the agent to talk to (`openclaw` = default agent).
  Drop the `chat` key for services without a chat.

Add more entries for anything else you run as a user or system unit; the
Tailscale toggle is independent of the services.

## OpenClaw setup used on the Odin 3

Rootless install, so it survives Armada image updates. Read the install
script before running it.

```sh
curl -fsSL https://openclaw.ai/install-cli.sh -o install-cli.sh
sh install-cli.sh --no-onboard
echo 'export PATH="$HOME/.openclaw/bin:$PATH"' >> ~/.bashrc
openclaw setup --baseline
openclaw config set gateway.bind loopback
openclaw config set gateway.port 18789
openclaw config set gateway.auth.mode token
openclaw config set gateway.auth.token "$(openssl rand -hex 32)"
openclaw config set gateway.tailscale.mode off                   # the plugin manages Serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'       # Serve proxies from loopback
openclaw config set gateway.auth.allowTailscale false            # identity auth needs managed Serve
openclaw config set gateway.publicOrigin https://<device>.<tailnet>.ts.net   # for `openclaw qr` (mobile app)
openclaw config set gateway.http.endpoints.chatCompletions.enabled true      # for the chat box
openclaw gateway install && systemctl --user disable openclaw-gateway.service
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' >> ~/.openclaw/.env && chmod 600 ~/.openclaw/.env
openclaw models set anthropic/claude-opus-5-5
```

`gateway.tailscale.mode` stays `off` on purpose: with `serve`, the gateway
refuses to start while Tailscale is down, which defeats independent toggles.
The price is that the Control UI asks for the gateway token once per browser
(`openclaw gateway auth-token --show` prints it); without `trustedProxies`
every request through Serve fails with `proxy_attribution_required`.

## Security notes

- The gateway token is read by the root backend from `token_file` and used
  only against `base_url` on loopback. It is never logged, never shown in the
  UI, never sent anywhere else.
- Whatever you type in the chat box runs as a normal agent turn. With
  OpenClaw's default exec policy the agent executes shell commands on the
  device without asking. Set `tools.exec.mode` to `ask` in OpenClaw if you
  want approvals.
- Serve publishes the service to your tailnet only (no Funnel). Anyone on the
  tailnet can reach the URL, and then needs the gateway token.
- `services.json` is a list of units the root backend will start, stop,
  enable and disable. Keep it to things you trust.

## Before installing: log Tailscale in once

The plugin only switches an existing Tailscale login on and off; it does not
do the browser login for you. Once, from a terminal on the device (Desktop
Mode → Konsole) or over SSH:

```sh
sudo systemctl enable --now tailscaled
sudo tailscale up --hostname=my-handheld --operator=$USER
```

`tailscale up` prints a login URL — open it on any device, approve, done.
From then on the plugin reuses those preferences. It deliberately calls
`tailscale up` with no flags: Tailscale refuses to change settings unless
every flag is repeated, so keep the flags for this one-time command.

## Install

### One line, on the device

From a terminal on the device (Desktop Mode → Konsole, or SSH):

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/aanze/deckops-decky/main/install.sh)"
```

It downloads the latest release and puts it in `~/homebrew/plugins/` — that
step asks for your password because Decky keeps that folder root-owned. Run
it again to update. Decky loads the plugin on its own; if it does not show up,
`sudo systemctl restart plugin_loader`.

Upgrading from *Tailscale Toggle*: remove the old folder first
(`sudo rm -rf ~/homebrew/plugins/tailscale-toggle`). The settings directory
is new (`deckops`), so `services.json` is recreated with the default above.

### From the zip

Download `deckops.zip` from the
[latest release](https://github.com/aanze/deckops-decky/releases/latest),
copy it to the device, then in Decky: **Settings → General → Developer mode**
on, **Settings → Developer → Install plugin from ZIP**.

### From source

On a computer with [Node.js](https://nodejs.org) 22+ and
[pnpm](https://pnpm.io) (`npm install -g pnpm`):

```sh
git clone https://github.com/aanze/deckops-decky.git
cd deckops-decky
pnpm install
scripts/deploy.sh user@device
```

`scripts/deploy.sh` builds, copies the plugin to the device with `scp`, then
installs it with `sudo` (asks for the device user's password).

## Development

```sh
pnpm install
pnpm watch          # rebuilds dist/ on change
```

Backend: `main.py` (`get_status`, `set_enabled`, `set_service_enabled`,
`set_service_autostart`, `chat_send`, `chat_cancel`; the chat streams through
the `chat_delta` / `chat_done` events). Frontend: `src/index.tsx` on
`@decky/ui` + `@decky/api`. `get_status` wraps `tailscale status --json`; run
it with a stub `decky` module to test without Decky:

```sh
mkdir -p /tmp/stub && printf 'import logging\nlogger=logging.getLogger("decky")\nDECKY_USER="deck"\nDECKY_USER_HOME="/home/deck"\nDECKY_PLUGIN_SETTINGS_DIR="/tmp/stub"\n' > /tmp/stub/decky.py
PYTHONPATH=/tmp/stub python3 -c 'import main, json; print(json.dumps(main.build_status(), indent=1))'
```

Releases are built by GitHub Actions on every `v*` tag.

## License

MIT
