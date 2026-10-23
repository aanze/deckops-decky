import { addEventListener, callable, definePlugin, removeEventListener, toaster, useQuickAccessVisible } from "@decky/api";
import {
  ButtonItem,
  Focusable,
  PanelSection,
  PanelSectionRow,
  TextField,
  ToggleField,
  staticClasses,
} from "@decky/ui";
import { FC, useCallback, useEffect, useRef, useState } from "react";

type State = "running" | "stopped" | "needs_login" | "no_daemon" | "missing" | "error";

interface Peer {
  name: string;
  os: string;
  ip: string;
  online: boolean;
  exit_node: boolean;
}

type ServiceState = "ready" | "starting" | "stopping" | "stopped" | "failed" | "missing";

interface Service {
  id: string;
  label: string;
  unit: string;
  scope: "user" | "system";
  state: ServiceState;
  autostart: boolean;
  serve: boolean;
  served: boolean;
  url: string;
  chat: boolean;
}

interface Status {
  installed: boolean;
  daemon: boolean;
  state: State;
  hostname: string;
  dns_name: string;
  ip4: string;
  ip6: string;
  tailnet: string;
  user: string;
  version: string;
  peers: Peer[];
  served: number[];
  services: Service[];
  error: string;
}

type Result = { ok: boolean; error?: string; warning?: string };

const getStatus = callable<[], Status>("get_status");
const setEnabled = callable<[enabled: boolean], Result>("set_enabled");
const setServiceEnabled = callable<[id: string, enabled: boolean], Result>("set_service_enabled");
const setServiceAutostart = callable<[id: string, enabled: boolean], Result>("set_service_autostart");
const chatSend = callable<[id: string, requestId: string, session: string, text: string], Result>("chat_send");
const chatCancel = callable<[], Result>("chat_cancel");

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  error?: string;
  pending?: boolean;
}

// Survives the panel closing (the content unmounts) while the plugin is loaded.
const chatStore = {
  session: `deckops-${Math.random().toString(36).slice(2, 10)}`,
  messages: [] as ChatMessage[],
  pendingId: "" as string,
};
const CHAT_MAX = 30;

const POLL_MS = 4000;

// Tailscale-ish palette, tuned for the dark Quick Access panel.
const C = {
  on: "#4ade80",
  off: "#6b7280",
  warn: "#fbbf24",
  err: "#f87171",
  text: "#e5e7eb",
  muted: "#9ca3af",
  card: "linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
  border: "rgba(255,255,255,0.08)",
};

const STATE_LABEL: Record<State, { text: string; color: string }> = {
  running: { text: "Connected", color: C.on },
  stopped: { text: "Disconnected", color: C.off },
  needs_login: { text: "Not logged in", color: C.warn },
  no_daemon: { text: "Daemon stopped", color: C.off },
  missing: { text: "Tailscale not installed", color: C.err },
  error: { text: "Error", color: C.err },
};

const SERVICE_LABEL: Record<ServiceState, { text: string; color: string }> = {
  ready: { text: "Running", color: C.on },
  starting: { text: "Starting…", color: C.warn },
  stopping: { text: "Stopping…", color: C.warn },
  stopped: { text: "Stopped", color: C.off },
  failed: { text: "Failed", color: C.err },
  missing: { text: "Not installed", color: C.err },
};

const Dot: FC<{ color: string; size?: number; glow?: boolean }> = ({ color, size = 10, glow }) => (
  <span
    style={{
      display: "inline-block",
      width: size,
      height: size,
      borderRadius: "50%",
      background: color,
      boxShadow: glow ? `0 0 8px ${color}` : "none",
      flexShrink: 0,
    }}
  />
);

const StatusCard: FC<{ status: Status | null; busy: boolean; onActivate: () => void }> = ({
  status,
  busy,
  onActivate,
}) => {
  const state = status?.state ?? "stopped";
  const label = STATE_LABEL[state];
  const running = state === "running";
  const subtitle = busy
    ? "Working…"
    : running
      ? status?.tailnet || status?.user || ""
      : state === "needs_login"
        ? "Run `sudo tailscale up` once in a terminal"
        : state === "missing"
          ? "Install the Tailscale CLI first"
          : status?.error || "";

  return (
    <Focusable
      onActivate={onActivate}
      style={{
        margin: "4px 0 6px",
        padding: "12px 14px",
        borderRadius: 10,
        background: C.card,
        border: `1px solid ${C.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Dot color={busy ? C.warn : label.color} size={12} glow={running && !busy} />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ color: C.text, fontWeight: 600, fontSize: 15, lineHeight: 1.2 }}>
            {busy ? (running ? "Disconnecting" : "Connecting") : label.text}
          </span>
          {subtitle && (
            <span
              style={{
                color: C.muted,
                fontSize: 11,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {subtitle}
            </span>
          )}
        </div>
      </div>

      {running && status && (
        <div
          style={{
            marginTop: 4,
            paddingTop: 8,
            borderTop: `1px solid ${C.border}`,
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            rowGap: 3,
            columnGap: 12,
            fontSize: 12,
          }}
        >
          <span style={{ color: C.muted }}>IPv4</span>
          <span style={{ color: C.text, fontFamily: "monospace", fontSize: 14, fontWeight: 600 }}>
            {status.ip4 || "—"}
          </span>
          <span style={{ color: C.muted }}>Host</span>
          <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {status.dns_name || status.hostname || "—"}
          </span>
          {status.user && status.user !== status.tailnet && (
            <>
              <span style={{ color: C.muted }}>Account</span>
              <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {status.user}
              </span>
            </>
          )}
        </div>
      )}
    </Focusable>
  );
};

const PeerRow: FC<{ peer: Peer }> = ({ peer }) => (
  <Focusable
    style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "7px 6px",
      borderRadius: 6,
      borderBottom: `1px solid ${C.border}`,
      opacity: peer.online ? 1 : 0.55,
    }}
  >
    <Dot color={peer.online ? C.on : C.off} size={8} />
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
      <span
        style={{
          color: C.text,
          fontSize: 13,
          fontWeight: 500,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {peer.name}
        {peer.exit_node && <span style={{ color: C.warn, fontSize: 10, marginLeft: 6 }}>exit node</span>}
      </span>
      <span style={{ color: C.muted, fontSize: 11, fontFamily: "monospace" }}>{peer.ip}</span>
    </div>
    <span
      style={{
        color: C.muted,
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        padding: "2px 6px",
        borderRadius: 4,
        border: `1px solid ${C.border}`,
      }}
    >
      {peer.os || "?"}
    </span>
  </Focusable>
);

const ServiceCard: FC<{
  service: Service;
  tailscaleUp: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onAutostart: (enabled: boolean) => void;
}> = ({ service, tailscaleUp, busy, onToggle, onAutostart }) => {
  const label = SERVICE_LABEL[service.state];
  const running = service.state === "ready" || service.state === "starting";
  const canToggle = !busy && service.state !== "missing" && service.state !== "stopping";
  const remote = tailscaleUp && service.served;
  const hint =
    service.state === "missing"
      ? `Unit ${service.unit} not found`
      : running && service.serve && tailscaleUp && !service.served
        ? "Tailscale Serve not applied (enable HTTPS on the tailnet)"
        : running && service.serve && !tailscaleUp
          ? "Local only · turn Tailscale on for remote access"
          : "";

  return (
    <Focusable
      style={{
        margin: "4px 0 6px",
        padding: "10px 12px 4px",
        borderRadius: 10,
        background: C.card,
        border: `1px solid ${C.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Dot color={busy ? C.warn : label.color} size={10} glow={service.state === "ready" && !busy} />
        <span style={{ color: C.text, fontWeight: 600, fontSize: 14, flex: 1 }}>{service.label}</span>
        <span style={{ color: label.color, fontSize: 12 }}>{busy ? "Working…" : label.text}</span>
      </div>
      {running && service.url && (
        <span
          style={{
            color: remote ? C.on : C.muted,
            fontSize: 11,
            fontFamily: "monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            paddingLeft: 20,
          }}
        >
          {service.url}
        </span>
      )}
      {hint && <span style={{ color: C.muted, fontSize: 11, paddingLeft: 20 }}>{hint}</span>}
      <ToggleField label="Enabled" checked={running} disabled={!canToggle} onChange={onToggle} bottomSeparator="none" />
      <ToggleField
        label="Start at boot"
        checked={service.autostart}
        disabled={busy || service.state === "missing"}
        onChange={onAutostart}
        bottomSeparator="none"
      />
    </Focusable>
  );
};

const Bubble: FC<{ msg: ChatMessage }> = ({ msg }) => {
  const user = msg.role === "user";
  return (
    <Focusable
      style={{
        alignSelf: user ? "flex-end" : "flex-start",
        maxWidth: "92%",
        padding: "6px 9px",
        borderRadius: 8,
        background: user ? "rgba(96,165,250,0.18)" : "rgba(255,255,255,0.06)",
        border: `1px solid ${msg.error ? C.err : C.border}`,
        color: C.text,
        fontSize: 12,
        lineHeight: 1.35,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: user ? undefined : "monospace",
      }}
    >
      {msg.text || (msg.pending ? "…" : "")}
      {msg.error && <div style={{ color: C.err, marginTop: 4 }}>{msg.error}</div>}
    </Focusable>
  );
};

const ChatBox: FC<{ service: Service }> = ({ service }) => {
  const [messages, setMessages] = useState<ChatMessage[]>(chatStore.messages);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(!!chatStore.pendingId);
  const endRef = useRef<HTMLDivElement>(null);

  const commit = (next: ChatMessage[]) => {
    chatStore.messages = next.slice(-CHAT_MAX);
    setMessages(chatStore.messages);
  };

  useEffect(() => {
    const onDelta = (ev: { id: string; delta: string }) => {
      if (ev.id !== chatStore.pendingId) return;
      const next = [...chatStore.messages];
      const last = next[next.length - 1];
      if (last && last.role === "assistant" && last.pending) {
        next[next.length - 1] = { ...last, text: last.text + ev.delta };
        commit(next);
      }
    };
    const onDone = (ev: { id: string; error?: string; cancelled?: boolean }) => {
      if (ev.id !== chatStore.pendingId) return;
      const next = [...chatStore.messages];
      const last = next[next.length - 1];
      if (last && last.role === "assistant" && last.pending) {
        next[next.length - 1] = {
          ...last,
          pending: false,
          error: ev.error,
          text: ev.cancelled ? `${last.text}\n[cancelled]` : last.text,
        };
        commit(next);
      }
      chatStore.pendingId = "";
      setSending(false);
    };
    addEventListener("chat_delta", onDelta);
    addEventListener("chat_done", onDone);
    return () => {
      removeEventListener("chat_delta", onDelta);
      removeEventListener("chat_done", onDone);
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const id = `${Date.now()}`;
    chatStore.pendingId = id;
    setSending(true);
    setDraft("");
    commit([...chatStore.messages, { role: "user", text }, { role: "assistant", text: "", pending: true }]);
    const res = await chatSend(service.id, id, chatStore.session, text);
    if (!res.ok && chatStore.pendingId === id) {
      // chat_done may not have fired (e.g. backend refused the call outright).
      const next = [...chatStore.messages];
      const last = next[next.length - 1];
      if (last?.pending) next[next.length - 1] = { ...last, pending: false, error: res.error || "Failed" };
      commit(next);
      chatStore.pendingId = "";
      setSending(false);
    }
  };

  const reset = () => {
    chatStore.session = `deckops-${Math.random().toString(36).slice(2, 10)}`;
    chatStore.pendingId = "";
    commit([]);
    setSending(false);
  };

  return (
    <>
      {messages.length > 0 && (
        <PanelSectionRow>
          <Focusable
            flow-children="vertical"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              maxHeight: 260,
              overflowY: "auto",
              padding: "4px 2px",
            }}
          >
            {messages.map((m, i) => (
              <Bubble key={i} msg={m} />
            ))}
            <div ref={endRef} />
          </Focusable>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <TextField
          label={`Ask ${service.label}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={sending}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={send} disabled={sending || !draft.trim()}>
          {sending ? "Waiting for reply…" : "Send"}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <Focusable style={{ display: "flex", gap: 8 }}>
          <ButtonItem layout="below" onClick={() => chatCancel()} disabled={!sending}>
            Stop
          </ButtonItem>
          <ButtonItem layout="below" onClick={reset} disabled={sending}>
            New session
          </ButtonItem>
        </Focusable>
      </PanelSectionRow>
    </>
  );
};

const Content: FC = () => {
  const visible = useQuickAccessVisible();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    try {
      setStatus(await getStatus());
    } catch (e) {
      console.error("[deckops] get_status failed", e);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [visible, refresh]);

  const onToggle = async (enabled: boolean) => {
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await setEnabled(enabled);
      if (!res.ok) {
        toaster.toast({ title: "Tailscale", body: res.error || "Toggle failed", critical: true });
      } else if (res.warning) {
        toaster.toast({ title: "Tailscale Serve", body: res.warning });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      refresh();
    }
  };

  const runService = async (title: string, fn: () => Promise<Result>) => {
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) {
        toaster.toast({ title, body: res.error || "Failed", critical: true });
      } else if (res.warning) {
        toaster.toast({ title, body: res.warning });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      refresh();
    }
  };

  const state = status?.state ?? "stopped";
  const canToggle = state === "running" || state === "stopped" || state === "no_daemon";
  const services = status?.services ?? [];
  const peers = status?.peers ?? [];
  const onlineCount = peers.filter((p) => p.online).length;

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <StatusCard status={status} busy={busy} onActivate={refresh} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Tailscale"
            description={status?.version ? `v${status.version}` : undefined}
            checked={state === "running"}
            disabled={busy || !canToggle}
            onChange={onToggle}
          />
        </PanelSectionRow>
      </PanelSection>

      {services.length > 0 && (
        <PanelSection title="Services">
          {services.map((svc) => (
            <PanelSectionRow key={svc.id}>
              <ServiceCard
                service={svc}
                tailscaleUp={state === "running"}
                busy={busy}
                onToggle={(on) => runService(svc.label, () => setServiceEnabled(svc.id, on))}
                onAutostart={(on) => runService(svc.label, () => setServiceAutostart(svc.id, on))}
              />
            </PanelSectionRow>
          ))}
        </PanelSection>
      )}

      {services
        .filter((svc) => svc.chat && svc.state === "ready")
        .map((svc) => (
          <PanelSection key={`chat-${svc.id}`} title={`${svc.label} chat`}>
            <ChatBox service={svc} />
          </PanelSection>
        ))}

      {state === "running" && (
        <PanelSection title={`Devices · ${onlineCount}/${peers.length} online`}>
          {peers.length === 0 ? (
            <PanelSectionRow>
              <span style={{ color: C.muted, fontSize: 12 }}>No other devices on this tailnet.</span>
            </PanelSectionRow>
          ) : (
            <PanelSectionRow>
              <Focusable flow-children="vertical" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {peers.map((p) => (
                  <PeerRow key={p.ip || p.name} peer={p} />
                ))}
              </Focusable>
            </PanelSectionRow>
          )}
        </PanelSection>
      )}

      <PanelSection>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={refresh} disabled={busy}>
            Refresh
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
};

// A handheld outline with a terminal prompt: switches and a line to the operator.
const Icon: FC = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x={2} y={6} width={20} height={12} rx={3} />
    <path d="M7 10l2.5 2L7 14" />
    <path d="M12 14h4" />
  </svg>
);

export default definePlugin(() => ({
  name: "DeckOps",
  titleView: <div className={staticClasses.Title}>DeckOps</div>,
  content: <Content />,
  icon: <Icon />,
}));
