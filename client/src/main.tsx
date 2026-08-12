import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AccessGate from "./components/AccessGate";
import "./index.css";

const PRELOAD_RELOAD_AT = "jarvis-preload-reload-at";
const PRELOAD_RELOAD_COOLDOWN_MS = 30_000;

// A page kept open across a new deployment can still reference an old hashed chunk.
// Vite exposes this event specifically so the shell can load the matching asset set.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  const lastReload = Number(window.sessionStorage.getItem(PRELOAD_RELOAD_AT));
  if (Number.isFinite(lastReload) && Date.now() - lastReload < PRELOAD_RELOAD_COOLDOWN_MS) return;
  window.sessionStorage.setItem(PRELOAD_RELOAD_AT, String(Date.now()));
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AccessGate>
      <App />
    </AccessGate>
  </React.StrictMode>,
);
