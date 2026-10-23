# Tailscale Toggle for Decky

A small [Decky Loader](https://decky.xyz) plugin that turns
[Tailscale](https://tailscale.com) on or off from the Quick Access Menu and
shows what your tailnet looks like from the device: state, tailnet IP, DNS
name, and the other machines with their online status. It can also start and
stop self-hosted services on the device (by default the
[OpenClaw](https://openclaw.ai) gateway) and expose them over Tailscale Serve
so you reach them from your phone.

Written for an **AYN Odin 3 running [Armada](https://github.com/armada-os/armada)**
(which ships the Tailscale CLI without a GUI), but nothing is Armada-specific:
it needs a Linux device with Decky Loader, `tailscale`/`tailscaled` installed
and `systemd`.

## What it does

- **Toggle** — `tailscale up` / `tailscale down`. If `tailscaled` is not
  running it is started first. Turning it off keeps the daemon alive so the
  next "on" is instant.
- **Status card** — Connected / Disconnected / Not logged in / Daemon stopped,
  IPv4, DNS name, account. Press A on it to refresh.
- **Devices** — every peer on the tailnet, online ones first, with OS and IP.
- **Services** — one card per service from `services.json` (see below):
  Enabled toggle (start/stop the systemd unit), "Start at boot" toggle
  (enable/disable it), state with a readiness probe on the service port, and
  the URL to use: the `https://<device>.<tailnet>.ts.net/` one when Tailscale
  is up and the port is served, the local one otherwise.
- Polls every 4 s while the panel is open, nothing runs when it is closed.

The backend runs as root (Decky `root` flag) because talking to `tailscaled`
requires it.

## Before installing: log Tailscale in once

The plugin only switches an existing Tailscale login on and off; it does not
do the browser login for you. Once, from a terminal on the device (Desktop
Mode → Konsole) or over SSH:

```sh
sudo systemctl enable --now tailscaled
sudo tailscale up --hostname=my-handheld
```

`tailscale up` prints a login URL — open it on any device, approve, done.
From then on the plugin reuses those preferences. It deliberately calls
`tailscale up` with no flags: Tailscale refuses to change settings unless
every flag is repeated, so keep the flags for this one-time command.

## Services (OpenClaw and friends)

Services live in `~/homebrew/settings/tailscale-toggle/services.json`, written
with this default on first run:

```json
[
  {
    "id": "openclaw",
    "label": "OpenClaw",
    "unit": "openclaw-gateway.service",
    "scope": "user",
    "port": 18789,
    "serve": true,
    "local_url": "http://127.0.0.1:18789"
  }
]
```

- `scope` — `user` for a `systemd --user` unit of the logged-in user (the
  backend reaches it from root with `systemctl --user -M <user>@`), `system`
  for a system unit.
- `port` — probed on 127.0.0.1 to show *Running* only once the service really
  answers (OpenClaw takes ~10–30 s to come up).
- `serve` — when the service is running and Tailscale is up, the plugin runs
  `tailscale serve --bg http://127.0.0.1:<port>`, which publishes it as
  `https://<device>.<tailnet>.ts.net/` to your tailnet only. The Serve config
  persists across `tailscale up/down`, so this only has to succeed once. It
  needs **HTTPS enabled on your tailnet** (Tailscale admin console → DNS →
  HTTPS Certificates); until then the plugin shows a toast with the enable
  link and the service stays reachable locally. The device user must be the
  Tailscale operator (`sudo tailscale set --operator=<user>`), which is the
  case after `sudo tailscale up --operator=<user>`.

Add more entries for anything else you run as a user or system unit; the
Tailscale toggle is independent of the services.

### OpenClaw setup used on the Odin 3

Rootless install, so it survives Armada image updates:

```sh
curl -fsSL https://openclaw.ai/install-cli.sh -o install-cli.sh   # read it, then:
sh install-cli.sh --no-onboard
echo 'export PATH="$HOME/.openclaw/bin:$PATH"' >> ~/.bashrc
openclaw setup --baseline
openclaw config set gateway.bind loopback
openclaw config set gateway.port 18789
openclaw config set gateway.auth.mode token
openclaw config set gateway.auth.token "$(openssl rand -hex 32)"
openclaw config set gateway.tailscale.mode off         # the plugin manages Serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'   # Serve proxies from loopback
openclaw config set gateway.auth.allowTailscale false  # identity auth only works with managed Serve
openclaw config set gateway.publicOrigin https://<device>.<tailnet>.ts.net  # lets `openclaw qr` pair the mobile app
openclaw gateway install && systemctl --user disable openclaw-gateway.service
printf 'ANTHROPIC_API_KEY=sk-ant-...
' >> ~/.openclaw/.env && chmod 600 ~/.openclaw/.env
openclaw models set anthropic/claude-opus-5-5
```

`gateway.tailscale.mode` stays `off` on purpose: with `serve`, the gateway
refuses to start while Tailscale is down, which defeats independent toggles.
The price is that the Control UI asks for the gateway token once per browser
(`openclaw gateway auth-token` prints it); without `trustedProxies` every
request through Serve fails with `proxy_attribution_required`.

## Install

### One line, on the device

From a terminal on the device (Desktop Mode → Konsole, or SSH):

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/aanze/tailscale-toggle-decky/main/install.sh)"
```

It downloads the latest release and puts it in `~/homebrew/plugins/` — that
step asks for your password because Decky keeps that folder root-owned. Run
it again to update. Decky loads the plugin on its own; if it does not show up,
`sudo systemctl restart plugin_loader`.

### From the zip

Download `tailscale-toggle.zip` from the
[latest release](https://github.com/aanze/tailscale-toggle-decky/releases/latest),
copy it to the device, then in Decky: **Settings → General → Developer mode**
on, **Settings → Developer → Install plugin from ZIP**.

### From source

On a computer with [Node.js](https://nodejs.org) 22+ and
[pnpm](https://pnpm.io) (`npm install -g pnpm`):

```sh
git clone https://github.com/aanze/tailscale-toggle-decky.git
cd tailscale-toggle-decky
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
`set_service_autostart`). Frontend:
`src/index.tsx` on `@decky/ui` + `@decky/api`. `get_status` wraps
`tailscale status --json`; run it with a stub `decky` module to test without
Decky:

```sh
mkdir -p /tmp/stub && printf 'import logging\nlogger=logging.getLogger("decky")\n' > /tmp/stub/decky.py
PYTHONPATH=/tmp/stub python3 -c 'import main, json; print(json.dumps(main.build_status(), indent=1))'
```

Releases are built by GitHub Actions on every `v*` tag.

## License

MIT
