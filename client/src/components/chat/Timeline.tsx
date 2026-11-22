import { useState, useEffect, type ReactNode } from "react";
import { Bubble } from "./Bubble";
import type { Msg } from "../../lib/chat/messages";
import {
  mergeTimeline,
  type RunActivity,
  type Approval,
  type Decision,
} from "../../lib/chat/workspace";

function Activity({ run }: { run: RunActivity }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (run.endedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.endedAt]);
  const latest = run.tools.at(-1);
  const paths = [...new Set(run.tools.flatMap((t) => t.paths ?? []))];
  return (
    <details className="rounded border border-hudborder bg-black/20 px-3 py-2 text-xs">
      <summary className="cursor-pointer">
        {run.endedAt
          ? "Activity complete"
          : (latest?.summary ?? latest?.name ?? "Working")}{" "}
        · {Math.max(0, Math.floor(((run.endedAt ?? now) - run.time) / 1000))}s ·
        Details
      </summary>
      <ul>
        {run.tools.map((t) => (
          <li className="mt-2" key={t.toolCallId}>
            {t.name} · {t.status}
            {(t.command || t.output) && (
              <details>
                <summary>Command and output</summary>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap">
                  {[t.command, t.output].filter(Boolean).join("\n")}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ul>
      {paths.length > 0 && <p>Files · {paths.join(", ")}</p>}
    </details>
  );
}

function ApprovalCard({
  record,
  resolve,
}: {
  record: Approval;
  resolve: (id: string, d: Decision) => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  async function decide(decision: Decision) {
    setWorking(true);
    setError("");
    try {
      await resolve(record.id, decision);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setWorking(false);
    }
  }
  if (record.status !== "pending")
    return (
      <p className="text-xs text-gray-400">
        Approval {record.status} · {record.command}
      </p>
    );
  return (
    <section className="rounded border border-amber-400/40 p-3 text-sm">
      <strong>Approval requested</strong>
      <pre className="overflow-auto whitespace-pre-wrap">{record.command}</pre>
      <p>{[record.host, record.cwd].filter(Boolean).join(" · ")}</p>
      <div className="mt-2 flex gap-2">
        {(["allow-once", "allow-always", "deny"] as const).map((d, i) => (
          <button
            disabled={working}
            key={d}
            className="btn-hud px-2"
            onClick={() => decide(d)}
          >
            {["Allow once", "Always allow", "Deny"][i]}
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function Timeline({
  messages,
  runs,
  approvals,
  resolve,
  streaming,
  runId,
}: {
  messages: Msg[];
  runs: RunActivity[];
  approvals: Approval[];
  resolve: (id: string, d: Decision) => Promise<void>;
  streaming: string | null;
  runId?: string;
}) {
  const rows = mergeTimeline<{ time: number; node: ReactNode }>(
    messages.map((m, i) => ({
      time: m.time ?? 0,
      node: <Bubble key={m.id ?? i} {...m} />,
    })),
    // A finished run that called no tools has nothing to show beyond its reply.
    runs
      .filter((r) => !r.endedAt || r.tools.length > 0)
      .map((r) => ({
      time: r.time,
      node: <Activity key={"activity-" + r.id} run={r} />,
    })),
    approvals.map((a) => ({
      time: a.requestedAt,
      node: <ApprovalCard key={a.id} record={a} resolve={resolve} />,
    })),
    streaming !== null
      ? [
          {
            time: Infinity,
            node: (
              <Bubble
                key={"reply-" + runId}
                role="agent"
                streaming
                text={streaming || "…"}
              />
            ),
          },
        ]
      : [],
  );
  return <>{rows.map((r) => r.node)}</>;
}
