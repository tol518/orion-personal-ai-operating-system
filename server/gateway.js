// Minimal OpenClaw gateway WebSocket client for the Jarvis BFF.
// Mirrors the connect handshake used by the built-in Control UI:
//   open socket -> receive event "connect.challenge" {nonce}
//   -> send req "connect" {client, role, scopes, auth.token}
//   -> receive res hello-ok.
// Connecting as client.id="openclaw-control-ui" + gateway token; over loopback
// (BFF runs on the Mac beside the gateway) no browser device pairing is needed.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const PROTOCOL_VERSION = 4;
const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

export class GatewayClient extends EventEmitter {
  constructor({ url, token, clientVersion = "0.1.0", origin = "http://127.0.0.1:18789" }) {
    super();
    this.url = url;
    this.token = token;
    this.clientVersion = clientVersion;
    this.origin = origin;
    this.ws = null;
    this.pending = new Map();
    this.connected = false;
    this.hello = null;
    this.lastError = null;
    this.reconnectDelay = 500;
    this.shouldRun = false;
  }

  start() {
    this.shouldRun = true;
    this.#connect();
  }

  stop() {
    this.shouldRun = false;
    this.ws?.close();
  }

  status() {
    return {
      connected: this.connected,
      server: this.hello?.server ?? null,
      scopes: this.hello?.auth?.scopes ?? [],
      error: this.lastError,
    };
  }

  #connect() {
    let ws;
    try {
      ws = new WebSocket(this.url, {
        maxPayload: 25 * 1024 * 1024,
        headers: { Origin: this.origin },
      });
    } catch (err) {
      this.lastError = String(err?.message ?? err);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("message", (raw) => this.#onMessage(raw));
    ws.on("error", (err) => {
      this.lastError = String(err?.message ?? err);
    });
    ws.on("close", (code, reason) => {
      const wasConnected = this.connected;
      this.connected = false;
      this.hello = null;
      for (const [, p] of this.pending) p.reject(new Error("gateway socket closed"));
      this.pending.clear();
      this.emit("status", this.status());
      if (wasConnected) this.emit("event", "gateway.disconnected", { code });
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (!this.shouldRun) return;
    setTimeout(() => this.#connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, 15000);
  }

  #send(obj) {
    this.ws?.send(JSON.stringify(obj));
  }

  #track(id) {
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  #sendConnect(nonce) {
    const id = randomUUID();
    const params = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "openclaw-control-ui",
        displayName: "Jarvis Dashboard",
        version: this.clientVersion,
        platform: process.platform,
        mode: "ui",
      },
      caps: ["tool-events"],
      role: "operator",
      scopes: OPERATOR_SCOPES,
      auth: { token: this.token },
    };
    const p = this.#track(id);
    this.#send({ type: "req", id, method: "connect", params });
    p.then((hello) => {
      this.hello = hello;
      this.connected = true;
      this.lastError = null;
      this.reconnectDelay = 500;
      this.emit("status", this.status());
    }).catch((err) => {
      this.lastError = String(err?.message ?? err);
      this.emit("status", this.status());
      this.ws?.close();
    });
  }

  request(method, params) {
    if (!this.connected) return Promise.reject(new Error("gateway not connected"));
    const id = randomUUID();
    const p = this.#track(id);
    this.#send({ type: "req", id, method, params });
    return p;
  }

  #onMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (frame.type === "event") {
      if (frame.event === "connect.challenge") {
        this.#sendConnect(frame.payload?.nonce);
        return;
      }
      this.emit("event", frame.event, frame.payload);
      return;
    }
    if (frame.type === "res") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.payload);
      else p.reject(new Error(frame.error?.message ?? "gateway request failed"));
    }
  }
}
