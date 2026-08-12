import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { enforceHuntingBrowserTarget } from "./policy.js";

export default definePluginEntry({
  id: "jarvis-hunting-browser-policy",
  name: "J.A.R.V.I.S. Hunting Browser Policy",
  description: "Rejects Hunting browser calls that do not target the controlled browser node.",
  register(api) {
    api.on("before_tool_call", enforceHuntingBrowserTarget);
  },
});
