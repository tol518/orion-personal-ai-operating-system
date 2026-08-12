import { useEffect, useRef } from "react";
import { subscribe } from "../lib/stream";

// Subscribe to a named SSE event for the component's lifetime. The latest
// callback is used without re-subscribing on every render.
export function useStreamEvent(event: string, cb: (data: any) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => subscribe(event, (data) => ref.current(data)), [event]);
}
