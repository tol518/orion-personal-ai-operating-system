export const HUNTING_SESSION_PREFIX = "agent:main:dashboard:hunting-application-";
const HUNTING_BROWSER_TOOL = "browser";

export function enforceHuntingBrowserTarget(event, ctx) {
  if (!String(ctx.sessionKey ?? "").startsWith(HUNTING_SESSION_PREFIX)) return undefined;
  // The BFF owns application tabs. Command tools trigger an approval-gated macOS/Safari
  // fallback, so browser is the only interactive surface exposed to application sessions.
  if (event.toolName !== HUNTING_BROWSER_TOOL) {
    return {
      block: true,
      blockReason: "Hunting application sessions may only use the controlled browser tool; Mac command, Safari, shell, and node-exec tools are unavailable.",
    };
  }
  if (event.params?.target === "node") return undefined;
  return {
    block: true,
    blockReason: 'Hunting browser calls must use target: "node"',
  };
}
