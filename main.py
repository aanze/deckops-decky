import asyncio
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import urllib.error
import urllib.request

import decky

TAILSCALE = shutil.which("tailscale") or "/usr/bin/tailscale"
SYSTEMCTL = shutil.which("systemctl") or "/usr/bin/systemctl"

# Decky runs this backend as root; user services belong to the logged-in user.
USER = getattr(decky, "DECKY_USER", "") or os.environ.get("DECKY_USER", "") or "deck"
USER_HOME = getattr(decky, "DECKY_USER_HOME", "") or os.environ.get("DECKY_USER_HOME", "") or f"/home/{USER}"
SETTINGS_DIR = getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", "") or os.path.join(USER_HOME, ".config", "deckops")
SERVICES_FILE = os.path.join(SETTINGS_DIR, "services.json")

# Services the plugin can start/stop. Users can add their own in services.json:
#   id         unique key
#   label      shown in the panel
#   unit       systemd unit name
#   scope      "user" (systemd --user of the logged-in user) or "system"
#   port       local TCP port to probe for readiness (optional)
#   serve      expose that port over Tailscale Serve (HTTPS on the tailnet) (optional)
#   local_url  what to show when Tailscale is off (optional)
#   chat       OpenAI-compatible chat endpoint of the service, for the chat box (optional):
#                base_url    e.g. http://127.0.0.1:18789
#                token_file  OpenClaw config file holding gateway.auth.token ("~" = the user's home)
#                model       value of the "model" field (OpenClaw: agent id, "openclaw" = default agent)
DEFAULT_SERVICES = [
    {
        "id": "openclaw",
        "label": "OpenClaw",
        "unit": "openclaw-gateway.service",
        "scope": "user",
        "port": 18789,
        "serve": True,
        "local_url": "http://127.0.0.1:18789",
        "chat": {
            "base_url": "http://127.0.0.1:18789",
            "token_file": "~/.openclaw/openclaw.json",
            "model": "openclaw",
        },
    }
]


def _run(args, timeout=15):
    """Run a command and return (returncode, stdout, stderr). Never raises on failure."""
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout, proc.stderr
    except FileNotFoundError:
        return 127, "", f"{args[0]}: not found"
    except subprocess.TimeoutExpired as e:
        # Keep whatever the command printed before the kill: `tailscale serve`
        # waits forever when Serve is not enabled, after printing the fix.
        out = (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        err = (e.stderr or b"").decode(errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
        return 124, out, (err or out).strip() or f"{' '.join(args)}: timed out after {timeout}s"



def _daemon_active():
    rc, out, _ = _run([SYSTEMCTL, "is-active", "tailscaled"], timeout=5)
    return out.strip() == "active"


# ---------------------------------------------------------------- services


def load_services():
    try:
        with open(SERVICES_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list) and data:
            return [s for s in data if isinstance(s, dict) and s.get("id") and s.get("unit")]
    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError) as e:
        decky.logger.warning("services.json unreadable (%s), using defaults", e)
    try:
        os.makedirs(SETTINGS_DIR, exist_ok=True)
        with open(SERVICES_FILE, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_SERVICES, f, indent=2)
    except OSError as e:
        decky.logger.warning("could not write %s: %s", SERVICES_FILE, e)
    return list(DEFAULT_SERVICES)


def _find_service(service_id):
    return next((s for s in load_services() if s["id"] == service_id), None)


def _systemctl(svc, *args, timeout=20):
    """systemctl for a service, in the right scope. User units are reached from
    root through `-M user@`; falls back to the runtime dir if the machine
    transport is unavailable."""
    if svc.get("scope", "user") != "user":
        return _run([SYSTEMCTL, *args], timeout=timeout)
    rc, out, err = _run([SYSTEMCTL, "--user", "-M", f"{USER}@", *args], timeout=timeout)
    if rc != 0 and "Failed to connect" in (err or ""):
        try:
            import pwd

            uid = pwd.getpwnam(USER).pw_uid
        except KeyError:
            return rc, out, err
        env = dict(os.environ, XDG_RUNTIME_DIR=f"/run/user/{uid}")
        try:
            proc = subprocess.run(
                ["runuser", "-u", USER, "--", "env", f"XDG_RUNTIME_DIR=/run/user/{uid}", SYSTEMCTL, "--user", *args],
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
            return proc.returncode, proc.stdout, proc.stderr
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return 1, "", str(e)
    return rc, out, err


def _port_open(port, host="127.0.0.1"):
    if not port:
        return False
    try:
        with socket.create_connection((host, int(port)), timeout=0.4):
            return True
    except OSError:
        return False


def _served_ports():
    """Ports currently proxied by `tailscale serve` (empty when Tailscale is off)."""
    rc, out, _ = _run([TAILSCALE, "serve", "status"], timeout=8)
    if rc != 0:
        return set()
    return {int(p) for p in re.findall(r"127\.0\.0\.1:(\d+)", out)}


def apply_serve(svc):
    """Expose the service port over Tailscale Serve (HTTPS, tailnet only).
    Returns an error string, or "" on success. Serve config persists across
    `tailscale up/down`, so this only needs to succeed once."""
    port = svc.get("port")
    if not svc.get("serve") or not port:
        return ""
    if port in _served_ports():
        return ""
    rc, out, err = _run([TAILSCALE, "serve", "--bg", f"http://127.0.0.1:{port}"], timeout=8)
    if rc != 0:
        msg = " ".join((err or out).split())
        decky.logger.warning("tailscale serve failed for %s: %s", svc["id"], msg)
        return msg[:400]
    return ""


def service_status(svc, ts):
    rc, out, _ = _systemctl(svc, "is-active", svc["unit"], timeout=8)
    active = out.strip() or "unknown"
    rc_e, out_e, _ = _systemctl(svc, "is-enabled", svc["unit"], timeout=8)
    enabled_raw = out_e.strip()
    missing = active == "unknown" and enabled_raw in ("", "not-found")
    if active == "active":
        state = "ready" if (not svc.get("port") or _port_open(svc["port"])) else "starting"
    elif active in ("activating", "reloading"):
        state = "starting"
    elif active in ("deactivating",):
        state = "stopping"
    elif active == "failed":
        state = "failed"
    elif missing:
        state = "missing"
    else:
        state = "stopped"

    served = bool(svc.get("serve")) and svc.get("port") in ts["served"] if ts["state"] == "running" else False
    url = ""
    if ts["state"] == "running" and served and ts["dns_name"]:
        url = f"https://{ts['dns_name']}/"
    elif svc.get("local_url"):
        url = svc["local_url"]

    return {
        "id": svc["id"],
        "label": svc.get("label") or svc["id"],
        "unit": svc["unit"],
        "scope": svc.get("scope", "user"),
        "state": state,  # ready | starting | stopping | stopped | failed | missing
        "autostart": enabled_raw == "enabled",
        "serve": bool(svc.get("serve")),
        "served": served,
        "url": url,
        "chat": bool(svc.get("chat")),
    }


# ---------------------------------------------------------------- tailscale


def _peer(p):
    ips = p.get("TailscaleIPs") or []
    return {
        "name": p.get("HostName") or p.get("DNSName", "").split(".")[0],
        "os": p.get("OS", ""),
        "ip": ips[0] if ips else "",
        "online": bool(p.get("Online")),
        "exit_node": bool(p.get("ExitNode")),
    }


def tailscale_status():
    status = {
        "installed": shutil.which("tailscale") is not None,
        "daemon": False,
        # one of: running | stopped | needs_login | no_daemon | missing | error
        "state": "missing",
        "hostname": "",
        "dns_name": "",
        "ip4": "",
        "ip6": "",
        "tailnet": "",
        "user": "",
        "version": "",
        "peers": [],
        "served": set(),
        "error": "",
    }
    if not status["installed"]:
        return status

    status["daemon"] = _daemon_active()
    if not status["daemon"]:
        status["state"] = "no_daemon"
        return status

    rc, out, err = _run([TAILSCALE, "status", "--json"], timeout=10)
    if rc != 0 or not out.strip():
        status["state"] = "error"
        status["error"] = (err or out).strip()[:300]
        return status

    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        status["state"] = "error"
        status["error"] = f"bad json from tailscale: {e}"
        return status

    backend = data.get("BackendState", "")
    if backend == "Running":
        status["state"] = "running"
    elif backend == "NeedsLogin":
        status["state"] = "needs_login"
    else:  # Stopped, Starting, NoState...
        status["state"] = "stopped"

    me = data.get("Self") or {}
    ips = me.get("TailscaleIPs") or []
    status["hostname"] = me.get("HostName", "")
    status["dns_name"] = (me.get("DNSName") or "").rstrip(".")
    status["ip4"] = next((ip for ip in ips if ":" not in ip), "")
    status["ip6"] = next((ip for ip in ips if ":" in ip), "")
    status["tailnet"] = (data.get("CurrentTailnet") or {}).get("Name", "")
    status["version"] = data.get("Version", "")
    users = data.get("User") or {}
    uid = str(me.get("UserID", ""))
    status["user"] = (users.get(uid) or {}).get("LoginName", "")

    peers = [_peer(p) for p in (data.get("Peer") or {}).values()]
    peers.sort(key=lambda p: (not p["online"], p["name"].lower()))
    status["peers"] = peers
    if status["state"] == "running":
        status["served"] = _served_ports()
    return status


def build_status():
    ts = tailscale_status()
    services = [service_status(s, ts) for s in load_services()]
    ts["served"] = sorted(ts["served"])
    ts["services"] = services
    return ts


def set_enabled(enabled):
    if enabled:
        if not _daemon_active():
            rc, _, err = _run([SYSTEMCTL, "start", "tailscaled"], timeout=20)
            if rc != 0:
                return {"ok": False, "error": f"could not start tailscaled: {err.strip()}"}
        # No flags on purpose: reuses the prefs from the initial `tailscale up`.
        rc, out, err = _run([TAILSCALE, "up"], timeout=30)
        if rc != 0:
            return {"ok": False, "error": (err or out).strip()[:300]}
        # Re-apply Serve for running services whose mapping is missing.
        warning = ""
        for svc in load_services():
            if svc.get("serve") and _port_open(svc.get("port")):
                warning = apply_serve(svc) or warning
        return {"ok": True, "warning": warning}
    rc, out, err = _run([TAILSCALE, "down"], timeout=20)
    if rc != 0:
        return {"ok": False, "error": (err or out).strip()[:300]}
    return {"ok": True}


def set_service_enabled(service_id, enabled):
    svc = _find_service(service_id)
    if not svc:
        return {"ok": False, "error": f"unknown service {service_id}"}
    rc, out, err = _systemctl(svc, "start" if enabled else "stop", svc["unit"], timeout=30)
    if rc != 0:
        return {"ok": False, "error": (err or out).strip()[:300]}
    warning = ""
    if enabled and svc.get("serve") and _daemon_active():
        rc_s, out_s, _ = _run([TAILSCALE, "status", "--json"], timeout=10)
        try:
            running = rc_s == 0 and json.loads(out_s).get("BackendState") == "Running"
        except json.JSONDecodeError:
            running = False
        if running:
            warning = apply_serve(svc)
    return {"ok": True, "warning": warning}


def set_service_autostart(service_id, enabled):
    svc = _find_service(service_id)
    if not svc:
        return {"ok": False, "error": f"unknown service {service_id}"}
    rc, out, err = _systemctl(svc, "enable" if enabled else "disable", svc["unit"], timeout=20)
    if rc != 0:
        return {"ok": False, "error": (err or out).strip()[:300]}
    return {"ok": True}


# ---------------------------------------------------------------- chat


def _expand_user_path(path):
    if path.startswith("~/"):
        return os.path.join(USER_HOME, path[2:])
    return path


def _chat_token(chat):
    """Gateway token, read from the service's config file. It never leaves the
    device: the backend talks to the gateway on loopback only."""
    token_file = chat.get("token_file")
    if not token_file:
        return ""
    try:
        with open(_expand_user_path(token_file), encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        decky.logger.warning("chat token file unreadable: %s", e)
        return ""
    try:
        cfg = json.loads(raw)
        return str(((cfg.get("gateway") or {}).get("auth") or {}).get("token") or "")
    except json.JSONDecodeError:
        m = re.search(r'"?token"?\s*:\s*"([^"]+)"', raw)  # JSON5 fallback
        return m.group(1) if m else ""


class ChatRun:
    def __init__(self, loop):
        self.loop = loop
        self.cancel = threading.Event()

    def emit(self, event, payload):
        asyncio.run_coroutine_threadsafe(decky.emit(event, payload), self.loop)

    def send(self, svc, request_id, session, text):
        chat = svc.get("chat") or {}
        base = (chat.get("base_url") or svc.get("local_url") or "").rstrip("/")
        if not base:
            return {"ok": False, "error": "no chat endpoint configured"}
        token = _chat_token(chat)
        body = json.dumps(
            {
                "model": chat.get("model") or "openclaw",
                "stream": True,
                "user": session,  # same value = same gateway session
                "messages": [{"role": "user", "content": text}],
            }
        ).encode("utf-8")
        headers = {"content-type": "application/json", "accept": "text/event-stream"}
        if token:
            headers["authorization"] = f"Bearer {token}"
        req = urllib.request.Request(f"{base}/v1/chat/completions", data=body, headers=headers, method="POST")
        self.cancel.clear()
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                for raw in resp:
                    if self.cancel.is_set():
                        self.emit("chat_done", {"id": request_id, "cancelled": True})
                        return {"ok": True, "cancelled": True}
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    for choice in chunk.get("choices") or []:
                        delta = (choice.get("delta") or {}).get("content")
                        if delta:
                            self.emit("chat_delta", {"id": request_id, "delta": delta})
            self.emit("chat_done", {"id": request_id})
            return {"ok": True}
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode("utf-8", errors="replace")).get("error", {}).get("message", "")
            except Exception:
                msg = ""
            err = f"HTTP {e.code}: {msg or e.reason}"
            if e.code == 404:
                err += " (enable gateway.http.endpoints.chatCompletions)"
            self.emit("chat_done", {"id": request_id, "error": err})
            return {"ok": False, "error": err}
        except (urllib.error.URLError, OSError) as e:
            err = f"gateway unreachable: {getattr(e, 'reason', e)}"
            self.emit("chat_done", {"id": request_id, "error": err})
            return {"ok": False, "error": err}


class Plugin:
    async def get_status(self):
        return await asyncio.to_thread(build_status)

    async def set_enabled(self, enabled: bool):
        decky.logger.info("tailscale %s", "up" if enabled else "down")
        result = await asyncio.to_thread(set_enabled, bool(enabled))
        if not result["ok"]:
            decky.logger.warning("tailscale toggle failed: %s", result["error"])
        return result

    async def set_service_enabled(self, service_id: str, enabled: bool):
        decky.logger.info("service %s %s", service_id, "start" if enabled else "stop")
        result = await asyncio.to_thread(set_service_enabled, str(service_id), bool(enabled))
        if not result["ok"]:
            decky.logger.warning("service toggle failed: %s", result["error"])
        return result

    async def set_service_autostart(self, service_id: str, enabled: bool):
        decky.logger.info("service %s autostart %s", service_id, enabled)
        return await asyncio.to_thread(set_service_autostart, str(service_id), bool(enabled))

    async def chat_send(self, service_id: str, request_id: str, session: str, text: str):
        """Stream one chat turn: emits chat_delta {id, delta} then chat_done {id, error?}."""
        svc = _find_service(str(service_id))
        if not svc or not svc.get("chat"):
            return {"ok": False, "error": f"no chat for service {service_id}"}
        text = str(text).strip()
        if not text:
            return {"ok": False, "error": "empty message"}
        decky.logger.info("chat %s: %d chars", service_id, len(text))
        return await asyncio.to_thread(self.chat.send, svc, str(request_id), str(session)[:64], text[:4000])

    async def chat_cancel(self):
        self.chat.cancel.set()
        return {"ok": True}

    async def _main(self):
        self.chat = ChatRun(asyncio.get_running_loop())
        decky.logger.info("DeckOps loaded (tailscale: %s, user: %s, services: %s)", TAILSCALE, USER, SERVICES_FILE)

    async def _unload(self):
        if getattr(self, "chat", None):
            self.chat.cancel.set()
