// Single SSE connection to the BFF, fanned out to subscribers by event name.
type Handler = (data: any) => void;

const KNOWN_EVENTS = [
  "gateway.status",
  "chat",
  "agent",
  "session.tool",
  "session.message",
  "sessions.changed",
  "node.presence.alive",
  "node.pair.requested",
  "node.pair.resolved",
  "gateway.disconnected",
  "memory.status",
  "memory.changed",
  "memory.proposals.changed",
  "hunting.applications.changed",
];

const listeners = new Map<string, Set<Handler>>();
let source: EventSource | null = null;

function ensureSource() {
  if (source) return;
  source = new EventSource("/api/events");
  for (const ev of KNOWN_EVENTS) {
    source.addEventListener(ev, (e: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(e.data);
      } catch {
        data = e.data;
      }
      listeners.get(ev)?.forEach((cb) => cb(data));
    });
  }
}

export function subscribe(event: string, cb: Handler): () => void {
  ensureSource();
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(cb);
  return () => set!.delete(cb);
}
