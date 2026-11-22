import { useCallback, useEffect, useRef, useState } from "react";
import { useStreamEvent } from "../../hooks/useStreamEvent";
import { api } from "../../lib/api";
import type { Approval, Decision } from "../../lib/chat/workspace";

export function useApprovals() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const version = revision.current;
    try {
      const result = await api.approvals();
      if (version === revision.current)
        setApprovals((rows) => [
          ...rows.filter(
            (a) =>
              a.status !== "pending" &&
              !result.approvals.some((p) => p.id === a.id),
          ),
          ...result.approvals,
        ]);
    } catch {
      /* Live requests still arrive through the event stream. */
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      revision.current++;
    };
  }, [refresh]);
  useStreamEvent("gateway.status", (s) => {
    if (s.connected) void refresh();
  });
  useStreamEvent("chat.approval", (record: Approval) => {
    revision.current++;
    setApprovals((rows) => [...rows.filter((a) => a.id !== record.id), record]);
  });
  useEffect(() => {
    const deadlines = approvals.flatMap((a) =>
      a.status === "pending" && a.expiresAt ? [a.expiresAt] : [],
    );
    if (!deadlines.length) return;
    const timer = setTimeout(
      () =>
        setApprovals((rows) =>
          rows.map((a) =>
            a.status === "pending" && a.expiresAt && a.expiresAt <= Date.now()
              ? { ...a, status: "expired" }
              : a,
          ),
        ),
      Math.max(0, Math.min(...deadlines) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [approvals]);
  async function resolve(id: string, decision: Decision) {
    await api.resolveApproval(id, decision);
    revision.current++;
    setApprovals((rows) =>
      rows.map((a) =>
        a.id === id && a.status === "pending"
          ? { ...a, status: decision === "deny" ? "denied" : "approved" }
          : a,
      ),
    );
  }
  return { approvals, resolve };
}
