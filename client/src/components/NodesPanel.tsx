import { Apple, MonitorSmartphone, Terminal, Trash2 } from "lucide-react";
import { useState } from "react";

type NodeRow = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  connected?: boolean;
  approvalState?: string;
  caps?: string[];
};

function platformIcon(platform?: string) {
  const p = (platform ?? "").toLowerCase();
  if (p.includes("darwin") || p.includes("mac")) return <Apple size={16} />;
  if (p.includes("win")) return <MonitorSmartphone size={16} />;
  return <Terminal size={16} />;
}

export default function NodesPanel({
  nodes,
  onDelete,
}: {
  nodes: NodeRow[];
  onDelete: (nodeId: string) => Promise<void>;
}) {
  const [confirmingNodeId, setConfirmingNodeId] = useState<string | null>(null);
  const [deletingNodeId, setDeletingNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function deleteNode(nodeId: string) {
    setDeletingNodeId(nodeId);
    setError(null);
    try {
      await onDelete(nodeId);
      setConfirmingNodeId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove node");
    } finally {
      setDeletingNodeId(null);
    }
  }

  return (
    <div className="space-y-2">
      {error && <div className="font-mono text-xs text-red-300">{error}</div>}
      {nodes.length === 0 && (
        <div className="py-4 text-center font-mono text-xs text-gray-600">No nodes paired.</div>
      )}
      {nodes.map((n) => (
        <div
          key={n.nodeId}
          className="flex items-center gap-3 rounded-lg border border-hudborder bg-surface-2/60 px-3 py-2"
        >
          <span className="text-accent/80">{platformIcon(n.platform)}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-gray-200">{n.displayName ?? n.nodeId.slice(0, 10)}</div>
            <div className="truncate font-mono text-[0.65rem] text-gray-500">
              {(n.platform ?? "node")} · {(n.caps ?? []).join(", ") || "—"}
            </div>
          </div>
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              n.connected ? "animate-core-pulse bg-emerald-400" : "bg-gray-600"
            }`}
            title={n.connected ? "connected" : "offline"}
          />
          {!n.connected &&
            (confirmingNodeId === n.nodeId ? (
              <div className="flex items-center gap-2">
                <span className="hidden font-mono text-[0.65rem] text-red-300 sm:inline">Unpair node?</span>
                <button
                  type="button"
                  className="rounded border border-hudborder px-2 py-1 font-mono text-[0.65rem] text-gray-400 hover:text-gray-200"
                  onClick={() => setConfirmingNodeId(null)}
                  disabled={deletingNodeId === n.nodeId}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded border border-red-500/60 bg-red-500/10 px-2 py-1 font-mono text-[0.65rem] text-red-200 hover:bg-red-500/20 disabled:opacity-50"
                  onClick={() => void deleteNode(n.nodeId)}
                  disabled={deletingNodeId === n.nodeId}
                >
                  {deletingNodeId === n.nodeId ? "Removing…" : "Delete"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="rounded p-1.5 text-gray-500 hover:bg-red-500/10 hover:text-red-300"
                aria-label={`Delete ${n.displayName ?? n.nodeId}`}
                title="Delete offline node"
                onClick={() => {
                  setError(null);
                  setConfirmingNodeId(n.nodeId);
                }}
              >
                <Trash2 size={15} />
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}
