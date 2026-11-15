/**
 * A small Discord Gateway client for the support process: it receives guild messages and reactions. Slash commands and
 * buttons keep going to the API's interactions endpoint; this connection only listens. Reconnects by itself, resuming
 * the session when Discord allows it.
 */

export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  MESSAGE_CONTENT: 1 << 15,
} as const;
export const SUPPORT_INTENTS = INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.GUILD_MESSAGE_REACTIONS | INTENTS.MESSAGE_CONTENT;

/** Close codes after which reconnecting cannot help until someone changes a setting. */
export const FATAL_CLOSE: Record<number, string> = {
  4004: "the bot token was rejected",
  4013: "invalid intents",
  4014: "Message Content Intent is not enabled for the bot (Developer Portal > Bot > Privileged Gateway Intents)",
};

export type Dispatch = (event: string, data: unknown) => void | Promise<void>;

export interface GatewayOptions {
  token: string;
  intents?: number;
  onDispatch: Dispatch;
  log: (fields: Record<string, unknown>) => void;
  /** Where to connect; read from GET /gateway/bot when omitted. */
  url?: string;
  WebSocketImpl?: typeof WebSocket;
}

interface Payload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

export function startGateway(o: GatewayOptions): { stop: () => void } {
  const WS = o.WebSocketImpl ?? WebSocket;
  let seq: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let acked = true;
  let stopped = false;
  let ws: WebSocket | null = null;
  let backoffMs = 2_000;

  const baseUrl = async () => {
    if (o.url) return o.url;
    const r = await fetch("https://discord.com/api/v10/gateway/bot", { headers: { Authorization: `Bot ${o.token}` } });
    if (!r.ok) throw new Error(`GET /gateway/bot: ${r.status}`);
    return ((await r.json()) as { url: string }).url;
  };

  const send = (op: number, d: unknown) => ws?.readyState === 1 && ws.send(JSON.stringify({ op, d }));

  const clearBeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  async function connect(): Promise<void> {
    if (stopped) return;
    const resuming = Boolean(sessionId && resumeUrl);
    let url: string;
    try {
      url = resuming ? resumeUrl! : await baseUrl();
    } catch (e) {
      o.log({ gateway: "url failed", error: e instanceof Error ? e.message : String(e) });
      return void setTimeout(connect, backoffMs);
    }
    ws = new WS(`${url}/?v=10&encoding=json`);
    ws.onmessage = (ev) => {
      const p = JSON.parse(String(ev.data)) as Payload;
      if (p.s !== null) seq = p.s;
      switch (p.op) {
        case 10: {
          const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval;
          clearBeat();
          acked = true;
          heartbeat = setInterval(() => {
            if (!acked) return ws?.close(4000, "heartbeat not acknowledged");
            acked = false;
            send(1, seq);
          }, interval);
          if (resuming) send(6, { token: o.token, session_id: sessionId, seq });
          else send(2, { token: o.token, intents: o.intents ?? SUPPORT_INTENTS, properties: { os: "linux", browser: "orrery-support", device: "orrery-support" } });
          break;
        }
        case 11:
          acked = true;
          break;
        case 1:
          send(1, seq);
          break;
        case 7: // reconnect requested: resume
          ws?.close(4000, "reconnect requested");
          break;
        case 9: // invalid session: start a new one unless Discord says it can be resumed
          if (!p.d) {
            sessionId = null;
            resumeUrl = null;
            seq = null;
          }
          ws?.close(4000, "invalid session");
          break;
        case 0: {
          if (p.t === "READY") {
            const d = p.d as { session_id: string; resume_gateway_url: string; user: { id: string; username: string } };
            sessionId = d.session_id;
            resumeUrl = d.resume_gateway_url;
            backoffMs = 2_000;
            o.log({ gateway: "ready", bot: d.user.username });
          } else if (p.t === "RESUMED") {
            backoffMs = 2_000;
            o.log({ gateway: "resumed" });
          }
          void Promise.resolve(o.onDispatch(p.t ?? "", p.d)).catch((e) => o.log({ gateway: "handler failed", event: p.t, error: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
          break;
        }
      }
    };
    ws.onclose = (ev) => {
      clearBeat();
      if (stopped) return;
      const fatal = FATAL_CLOSE[ev.code];
      if (fatal) {
        sessionId = null;
        resumeUrl = null;
        o.log({ gateway: "closed", code: ev.code, problem: fatal, retryInMin: 10 });
        return void setTimeout(connect, 10 * 60_000);
      }
      // 4007 (bad seq), 4009 (timed out): a new session; anything else resumes.
      if (ev.code === 4007 || ev.code === 4009) {
        sessionId = null;
        resumeUrl = null;
      }
      o.log({ gateway: "closed", code: ev.code, reconnectInMs: backoffMs });
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    };
    ws.onerror = () => {
      // onclose follows and reconnects
    };
  }

  void connect();
  return {
    stop: () => {
      stopped = true;
      clearBeat();
      ws?.close(1000, "stopping");
    },
  };
}
