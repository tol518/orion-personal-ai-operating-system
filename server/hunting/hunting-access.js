import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;

export class HuntingAccess {
  constructor({
    password,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    failureWindowMs = DEFAULT_FAILURE_WINDOW_MS,
    maxFailures = DEFAULT_MAX_FAILURES,
    now = () => Date.now(),
  } = {}) {
    this.passwordDigest = password ? digest(password) : null;
    this.sessionTtlMs = sessionTtlMs;
    this.failureWindowMs = failureWindowMs;
    this.maxFailures = maxFailures;
    this.now = now;
    this.sessions = new Map();
    this.failures = new Map();
  }

  get configured() {
    return this.passwordDigest !== null;
  }

  unlock(password, clientKey) {
    if (!this.configured) throw accessError("Hunting access is not configured", 503);
    const key = String(clientKey || "unknown");
    const failure = this.activeFailure(key);
    if (failure?.count >= this.maxFailures) {
      const retryAfter = Math.max(1, Math.ceil((failure.resetAt - this.now()) / 1000));
      throw accessError("Too many attempts. Try again later.", 429, { retryAfter });
    }

    const supplied = digest(String(password ?? ""));
    if (!timingSafeEqual(supplied, this.passwordDigest)) {
      this.recordFailure(key);
      throw accessError("Incorrect password", 401);
    }

    this.failures.delete(key);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.sessionTtlMs;
    this.sessions.set(token, expiresAt);
    return { token, expiresAt };
  }

  verify(token) {
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revoke(token) {
    if (token) this.sessions.delete(token);
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
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function accessError(message, statusCode, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}
