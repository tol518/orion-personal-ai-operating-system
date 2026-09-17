// The browser API's authentication boundary, in one place.
//
// This used to be about sixty lines scattered through index.js: a cookie constant near the top,
// an access instance in the middle, three routes, a gate middleware, and two helper functions
// three thousand lines further down. A deployment assembled by hand from that source ended up
// with none of it, and served every /api route — sessions, transcripts, the Second Brain, and
// /api/chat into agents holding system.run — to anything that could reach the port. Nothing
// noticed, because nothing checked.
//
// Two things follow. The whole boundary is this module, so porting it is one file and three
// lines. And assertGateOrder() inspects the live Express router at startup and refuses to serve
// if the gate is missing or in the wrong place. Express applies middleware in registration
// order, so position is as load-bearing as presence: a gate registered after a route does not
// protect it.
import { HuntingAccess } from "./hunting/hunting-access.js";

export const APP_SESSION_COOKIE = "jarvis_session";

/** Routes that must stay reachable without a session: they are how a client obtains one. */
export const PUBLIC_API_PATHS = Object.freeze([
  "/api/health",
  "/api/auth/status",
  "/api/auth/login",
  "/api/auth/logout",
]);

/** Mounts that must sit in front of the gate because they authenticate on their own. */
const SELF_AUTHENTICATING_MOUNTS = Object.freeze(["/api/v1/desktop"]);

/**
 * Origins allowed to sign in. Loopback on the BFF port and the Vite dev port are always
 * included; anything else — such as a Tailscale Serve HTTPS name — must be configured, because
 * sign-in is refused for any origin not in this set.
 */
export function buildAllowedOrigins(configured, port) {
  const origins = new Set(
    String(configured ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const hostname of ["127.0.0.1", "localhost"]) {
    origins.add(`http://${hostname}:${port}`);
    origins.add(`http://${hostname}:5173`);
  }
  return origins;
}

/**
 * Builds the boundary. Fail-closed by construction: without a password, `access.configured` is
 * false, `verify()` never returns true, and every gated route answers 401 while sign-in answers
 * 503 — a misconfigured deployment locks everyone out rather than letting everyone in.
 */
export function createBrowserAuth({ password, allowedOrigins, port }) {
  const access = new HuntingAccess({ password });
  const origins = buildAllowedOrigins(allowedOrigins, port);

  const ok = (res, payload) => res.json({ ok: true, ...payload });
  const fail = (res, err, code = 502) =>
    res.status(err?.statusCode ?? code).json({ ok: false, error: String(err?.message ?? err) });

  /** The session token from the request's cookie header, or "" when absent or malformed. */
  function tokenFrom(req) {
    const cookies = String(req.get?.("cookie") ?? "").split(";");
    for (const cookie of cookies) {
      const separator = cookie.indexOf("=");
      if (separator < 0) continue;
      if (cookie.slice(0, separator).trim() !== APP_SESSION_COOKIE) continue;
      try {
        return decodeURIComponent(cookie.slice(separator + 1).trim());
      } catch {
        return "";
      }
    }
    return "";
  }

  /** True when the request's Origin is one this dashboard is served from. */
  function requestIsSameOrigin(req) {
    const origin = req.get?.("origin");
    if (!origin) return false;
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && origins.has(parsed.origin);
    } catch {
      return false;
    }
  }

  /** The gate. Mount it on "/api" after the public routes and the desktop router, before all else. */
  function gate(req, res, next) {
    if (!access.verify(tokenFrom(req))) return fail(res, "Authentication required", 401);
    next();
  }

  /** The three routes a browser needs to obtain, check, and drop a session. */
  function mountRoutes(app) {
    app.get("/api/auth/status", (req, res) => {
      ok(res, { authenticated: access.verify(tokenFrom(req)) });
    });

    app.post("/api/auth/login", (req, res) => {
      if (!requestIsSameOrigin(req)) return fail(res, "Sign-in requires the JARVIS page", 403);
      try {
        const session = access.unlock(req.body?.password, req.ip);
        res.cookie(APP_SESSION_COOKIE, session.token, {
          httpOnly: true,
          sameSite: "strict",
          secure: req.secure,
          maxAge: Math.max(0, session.expiresAt - Date.now()),
          path: "/",
        });
        ok(res, { authenticated: true });
      } catch (err) {
        if (err?.retryAfter) res.set("Retry-After", String(err.retryAfter));
        fail(res, err, 401);
      }
    });

    app.post("/api/auth/logout", (req, res) => {
      if (!requestIsSameOrigin(req)) return fail(res, "Sign-out requires the JARVIS page", 403);
      access.revoke(tokenFrom(req));
      res.clearCookie(APP_SESSION_COOKIE, { path: "/" });
      ok(res, { authenticated: false });
    });
  }

  return {
    access,
    get configured() {
      return access.configured;
    },
    allowedOrigins: origins,
    tokenFrom,
    requestIsSameOrigin,
    gate,
    mountRoutes,
    assertGateOrder: (app, options = {}) => assertGateOrder(app, { gate, ...options }),
    inspectGateOrder: (app) => inspectGateOrder(app, { gate }),
  };
}

/**
 * Every way the boundary can be wrong, as plain sentences. Empty means it is in place.
 *
 * Walks the live Express 4 router stack rather than reading source, so it sees what will
 * actually run — including routes added by private code the public source knows nothing about.
 */
export function inspectGateOrder(app, { gate, publicPaths = PUBLIC_API_PATHS } = {}) {
  const stack = app?._router?.stack;
  if (!Array.isArray(stack)) {
    return ["the Express router stack could not be inspected (no routes mounted, or an unsupported Express version)"];
  }
  const problems = [];
  const gateIndex = stack.findIndex((layer) => layer?.handle === gate);
  if (gateIndex === -1) {
    problems.push('app.use("/api", browserAuth.gate) is not mounted — every browser API route is unauthenticated');
  }

  const publicSet = new Set(publicPaths);
  const seenPublic = new Set();

  stack.forEach((layer, index) => {
    const route = layer?.route;
    if (route) {
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      const methods =
        Object.keys(route.methods ?? {})
          .map((m) => m.toUpperCase())
          .join(",") || "ALL";
      for (const path of paths) {
        if (typeof path !== "string" || !path.startsWith("/api")) continue;
        if (publicSet.has(path)) {
          seenPublic.add(path);
          if (gateIndex !== -1 && index > gateIndex) {
            problems.push(`${methods} ${path} is registered after the gate, so it cannot be used to sign in`);
          }
          continue;
        }
        if (gateIndex === -1 || index < gateIndex) {
          problems.push(`${methods} ${path} is registered before the gate and answers without authentication`);
        }
      }
      return;
    }
    // A mounted Router. Only self-authenticating ones may precede the gate; the desktop router
    // must, because a native client has no browser origin and cannot pass a cookie check.
    if (layer?.name === "router" && layer.regexp) {
      for (const mount of SELF_AUTHENTICATING_MOUNTS) {
        if (layer.regexp.test(`${mount}/probe`) && gateIndex !== -1 && index > gateIndex) {
          problems.push(`the ${mount} router is mounted after the gate, so the native client cannot authenticate`);
        }
      }
    }
  });

  for (const path of publicPaths) {
    if (!seenPublic.has(path)) {
      problems.push(`${path} is not registered — ${path.includes("/auth/") ? "nobody can sign in" : "the health check is missing"}`);
    }
  }
  return problems;
}

/**
 * Refuses to start unless the boundary is in place. Call it immediately before app.listen().
 *
 * `allowUngated` exists for a deliberate, documented choice to run without the boundary. It
 * downgrades the failure to a loud warning; it does not make the state acceptable.
 */
export function assertGateOrder(app, { gate, publicPaths, allowUngated = false, warn = console.warn } = {}) {
  const problems = inspectGateOrder(app, { gate, publicPaths });
  if (problems.length === 0) return;
  const detail = problems.map((p) => `  - ${p}`).join("\n");
  if (allowUngated) {
    warn(
      `[jarvis-bff] The browser API authentication boundary is NOT in place:\n${detail}\n` +
        "  Starting anyway because ORION_ALLOW_UNGATED_API=1 is set. Every browser API route is open.",
    );
    return;
  }
  throw new Error(
    `The browser API authentication boundary is not in place:\n${detail}\n` +
      "Refusing to start. Fix the mount order in index.js, or set ORION_ALLOW_UNGATED_API=1 " +
      "only if running without authentication is a deliberate choice.",
  );
}
