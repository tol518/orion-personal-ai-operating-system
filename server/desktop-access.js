// Desktop client credential boundary for Orion.app.
//
// The browser boundary (see /api/auth/login in index.js) authenticates with a password that sets
// an httpOnly cookie and is gated on requestIsSameOrigin(). A native macOS client has no browser
// origin, so that mechanism cannot be extended to it without weakening the browser's own check.
//
// This is the adjacent, narrower mechanism: a pairing secret is exchanged once for a bearer token
// bound to a declared client identity. Tokens are revocable per device and carry no gateway
// authority of their own — every desktop request is still authorized server-side before it
// reaches the gateway. Revoking a desktop client never requires rotating GATEWAY_TOKEN.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;
const MAX_AUDIT_EVENTS = 200;
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PLATFORMS = new Set(["macos", "windows", "linux", "unknown"]);

export class DesktopAccess {
  constructor({
    pairingSecret,
    allowedClients = [],
    tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
    failureWindowMs = DEFAULT_FAILURE_WINDOW_MS,
    maxFailures = DEFAULT_MAX_FAILURES,
    now = () => Date.now(),
  } = {}) {
    this.secretDigest = pairingSecret ? digest(pairingSecret) : null;
    this.allowedClients = new Set(
      (Array.isArray(allowedClients) ? allowedClients : String(allowedClients ?? "").split(","))
        .map((value) => String(value).trim().toLowerCase())
        .filter(Boolean),
    );
    this.tokenTtlMs = tokenTtlMs;
    this.failureWindowMs = failureWindowMs;
    this.maxFailures = maxFailures;
    this.now = now;
    this.tokens = new Map();
    this.failures = new Map();
    this.auditEvents = [];
  }

  /** False until ORION_DESKTOP_PAIRING_SECRET is set. The whole surface stays closed until then. */
  get configured() {
    return this.secretDigest !== null;
  }

  /** True when an explicit device allowlist is in force. */
  get allowlistEnforced() {
    return this.allowedClients.size > 0;
  }

  pair({ pairingSecret, clientId, clientName, platform, clientKey } = {}) {
    if (!this.configured) {
      throw accessError("Desktop access is not configured on this host", 503);
    }
    const id = String(clientId ?? "").trim();
    if (!CLIENT_ID_PATTERN.test(id)) {
      throw accessError("clientId must be a safe identifier of 1-64 characters", 400);
    }
    if (this.allowlistEnforced && !this.allowedClients.has(id.toLowerCase())) {
      this.record("pair", id, "denied", "client not in allowlist");
      throw accessError("This device is not allowed to pair", 403);
    }

    const key = String(clientKey || id);
    const failure = this.activeFailure(key);
    if (failure && failure.count >= this.maxFailures) {
      const retryAfter = Math.max(1, Math.ceil((failure.resetAt - this.now()) / 1000));
      this.record("pair", id, "throttled");
      throw accessError("Too many attempts. Try again later.", 429, { retryAfter });
    }

    const supplied = digest(String(pairingSecret ?? ""));
    if (!timingSafeEqual(supplied, this.secretDigest)) {
      this.recordFailure(key);
      this.record("pair", id, "rejected", "incorrect pairing secret");
      throw accessError("Incorrect pairing secret", 401);
    }

    this.failures.delete(key);
    const token = randomBytes(32).toString("base64url");
    const issuedAt = this.now();
    const client = {
      clientId: id,
      clientName: cleanLabel(clientName) ?? id,
      platform: PLATFORMS.has(platform) ? platform : "unknown",
      issuedAt,
      expiresAt: issuedAt + this.tokenTtlMs,
      lastSeenAt: issuedAt,
    };
    this.tokens.set(token, client);
    this.record("pair", id, "granted");
    return { token, client: { ...client } };
  }

  /** Returns the client record for a live token, or null. Touches lastSeenAt on success. */
  verify(token) {
    if (!token) return null;
    const client = this.tokens.get(token);
    if (!client) return null;
    if (client.expiresAt <= this.now()) {
      this.tokens.delete(token);
      this.record("verify", client.clientId, "expired");
      return null;
    }
    client.lastSeenAt = this.now();
    return client;
  }

  revoke(token) {
    const client = token ? this.tokens.get(token) : null;
    if (!client) return false;
    this.tokens.delete(token);
    this.record("unpair", client.clientId, "revoked");
    return true;
  }

  /** Revokes every token issued to one client id. Used to retire a lost or replaced device. */
  revokeClient(clientId) {
    const id = String(clientId ?? "").trim();
    let removed = 0;
    for (const [token, client] of this.tokens) {
      if (client.clientId !== id) continue;
      this.tokens.delete(token);
      removed += 1;
    }
    if (removed > 0) this.record("unpair", id, "revoked", `${removed} token(s)`);
    return removed;
  }

  /** Paired clients, newest first. Never includes tokens. */
  clients() {
    this.prune();
    return [...this.tokens.values()]
      .map((client) => ({ ...client }))
      .sort((a, b) => b.issuedAt - a.issuedAt);
  }

  /** Recent audit events. Actor, action, and outcome only — no credentials or prompt content. */
  audit() {
    return this.auditEvents.map((event) => ({ ...event }));
  }

  prune() {
    for (const [token, client] of this.tokens) {
      if (client.expiresAt <= this.now()) this.tokens.delete(token);
    }
  }

  activeFailure(key) {
    const failure = this.failures.get(key);
    if (!failure) return null;
    if (failure.resetAt <= this.now()) {
      this.failures.delete(key);
      return null;
    }
    return failure;
  }

  recordFailure(key) {
    const current = this.activeFailure(key);
    this.failures.set(key, {
      count: (current?.count ?? 0) + 1,
      resetAt: current?.resetAt ?? this.now() + this.failureWindowMs,
    });
  }

  /** Append an audit event. Callers must never pass secrets or user content as `reason`. */
  record(action, clientId, outcome, reason) {
    this.auditEvents.push({
      at: new Date(this.now()).toISOString(),
      action,
      clientId: clientId || null,
      outcome,
      ...(reason ? { reason } : {}),
    });
    if (this.auditEvents.length > MAX_AUDIT_EVENTS) {
      this.auditEvents.splice(0, this.auditEvents.length - MAX_AUDIT_EVENTS);
    }
  }
}

/** Reads the bearer token from an Authorization header. Returns "" when absent or malformed. */
export function desktopBearerToken(req) {
  const header = String(req.get?.("authorization") ?? "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function cleanLabel(value) {
  const text = typeof value === "string" ? value.trim().slice(0, 80) : "";
  return text || null;
}

function accessError(message, statusCode, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}
