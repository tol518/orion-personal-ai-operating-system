import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  BrainCircuit,
  GitBranch,
  ListFilter,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import type {
  Memory,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryStatus,
  NeuralMemoryStatus,
} from "../lib/memory-types";
import { useStreamEvent } from "../hooks/useStreamEvent";
import MemoryEditor from "./MemoryEditor";

const MemoryGraph = lazy(() => import("./MemoryGraph"));

type MobileTab = "list" | "graph" | "edit";

const FILTERS = ["All", "Extraction", "Shared Lessons", "Agent Instructions", "Projects", "People", "Preferences", "Decisions"] as const;

export default function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [nodes, setNodes] = useState<MemoryGraphNode[]>([]);
  const [edges, setEdges] = useState<MemoryGraphEdge[]>([]);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [neuralStatus, setNeuralStatus] = useState<NeuralMemoryStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(memoryIdFromHash);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("graph");
  const [pendingDeletion, setPendingDeletion] = useState<Memory | null>(null);
  const deferredSearch = useDeferredValue(search);

  const load = useCallback(async () => {
    try {
      const [memoryResponse, graphResponse, statusResponse, neuralResponse] = await Promise.all([
        api.memories(),
        api.memoryGraph(),
        api.memoryStatus(),
        api.neuralMemoryStatus(),
      ]);
      const nextMemories: Memory[] = memoryResponse.memories ?? [];
      setMemories(nextMemories);
      setNodes(graphResponse.nodes ?? []);
      setEdges(graphResponse.edges ?? []);
      setStatus(statusResponse.status ?? null);
      setNeuralStatus(neuralResponse.status ?? null);
      setSelectedId((current) => {
        if (current && nextMemories.some((memory) => memory.id === current)) return current;
        return nextMemories[0]?.id ?? null;
      });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load memory vault");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useStreamEvent("memory.changed", () => load());
  useStreamEvent("memory.status", (nextStatus) => setStatus(nextStatus));
  useStreamEvent("memory.neural.status", (nextStatus) => setNeuralStatus(nextStatus));

  const selected = memories.find((memory) => memory.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return memories.filter((memory) => {
      const matchesSearch = !query || `${memory.title}\n${memory.body}\n${memory.tags.join(" ")}`.toLowerCase().includes(query);
      if (!matchesSearch || filter === "All") return matchesSearch;
      if (filter === "Extraction") return memory.tags.some((tag) => tag.toLowerCase() === "extraction-related");
      if (filter === "Shared Lessons") return memory.memoryType === "shared_lesson";
      if (filter === "Agent Instructions") return memory.memoryType === "agent_instruction";
      if (filter === "Projects") return memory.memoryType === "project";
      if (filter === "People") return memory.tags.some((tag) => ["person", "people", "identity"].includes(tag.toLowerCase()));
      if (filter === "Preferences") return memory.tags.some((tag) => ["preference", "preferences"].includes(tag.toLowerCase()));
      return memory.tags.some((tag) => ["decision", "decisions"].includes(tag.toLowerCase()));
    });
  }, [deferredSearch, filter, memories]);

  function selectMemory(id: string | null) {
    setCreating(false);
    setSelectedId(id);
    // Deselecting is a graph gesture: stay where we are rather than pushing the editor into view.
    if (id) {
      setMobileTab("edit");
      window.history.replaceState(null, "", `#memory?id=${encodeURIComponent(id)}`);
      return;
    }
    window.history.replaceState(null, "", "#memory");
  }

  function startCreate() {
    setCreating(true);
    setMobileTab("edit");
  }

  function handleSaved(memory: Memory) {
    setCreating(false);
    setSelectedId(memory.id);
    window.history.replaceState(null, "", `#memory?id=${encodeURIComponent(memory.id)}`);
    load();
  }

  function requestDeletion(id: string) {
    const memory = memories.find((item) => item.id === id);
    if (!memory) return;
    setPendingDeletion(memory);
  }

  async function deleteMemory() {
    if (!pendingDeletion) return;
    try {
      await api.deleteMemory(pendingDeletion.id, pendingDeletion.revision);
      setCreating(false);
      setMobileTab("graph");
      window.history.replaceState(null, "", "#memory");
      setPendingDeletion(null);
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete memory");
    }
  }

  return (
    <div className="memory-page">
      <header className="memory-header">
        <div>
          <h1>Second Brain</h1>
          <p>Obsidian wiki · persistent, compounding memory</p>
        </div>
        <div className="memory-header-actions">
          <div className="memory-compound-loop" aria-label="Second brain workflow">
            QUERY <span>→</span> LEARN <span>→</span> COMPOUND
          </div>
          <div className={`memory-sync ${status?.connected ? "memory-sync--online" : "memory-sync--offline"}`}>
            <span />
            {status?.connected ? "Vault synced" : status?.configured ? "Vault reconnecting" : "Vault not configured"}
          </div>
          <div
            className={`memory-neural-status ${neuralStatus?.lastError ? "memory-neural-status--error" : ""}`}
            title={neuralStatus?.lastError ?? `Local embeddings · top ${neuralStatus?.candidateLimit ?? 40} · Codex OAuth`}
          >
            <Sparkles size={13} />
            <span>{neuralStatus?.running ? "LUNA LINKING" : "LUNA NEURAL"}</span>
            <b>{formatContext(neuralStatus?.contextWindow)}</b>
          </div>
          <button className="btn-hud memory-new-button" onClick={startCreate}>
            <Plus size={17} />
            New memory
          </button>
        </div>
      </header>

      <nav className="memory-mobile-tabs" aria-label="Memory workspace panels">
        <MobileTabButton icon={<ListFilter size={14} />} label="List" active={mobileTab === "list"} onClick={() => setMobileTab("list")} />
        <MobileTabButton icon={<GitBranch size={14} />} label="Graph" active={mobileTab === "graph"} onClick={() => setMobileTab("graph")} />
        <MobileTabButton icon={<BrainCircuit size={14} />} label="Edit" active={mobileTab === "edit"} onClick={() => setMobileTab("edit")} />
      </nav>

      {error ? (
        <div className="memory-error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => { setError(null); load(); }}><RefreshCw size={14} /> Retry</button>
        </div>
      ) : null}

      {pendingDeletion ? (
        <div className="memory-delete-dialog-backdrop" role="presentation">
          <section className="memory-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-delete-title">
            <span className="memory-delete-dialog__eyebrow">PERMANENT VAULT CHANGE</span>
            <h2 id="memory-delete-title">Delete “{pendingDeletion.title}”?</h2>
            <p>This removes its Markdown page from Obsidian and clears relationships pointing to it.</p>
            <div className="memory-delete-dialog__actions">
              <button className="btn-hud" onClick={() => setPendingDeletion(null)}>Cancel</button>
              <button className="memory-delete-dialog__confirm" onClick={deleteMemory}>Delete memory</button>
            </div>
          </section>
        </div>
      ) : null}

      <div className="memory-workspace">
        <section className={`memory-library ${mobileTab === "list" ? "memory-mobile-active" : ""}`}>
          <div className="memory-search">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search memories"
              aria-label="Search memories"
            />
            {search ? <button onClick={() => setSearch("")} aria-label="Clear memory search"><X size={14} /></button> : null}
          </div>

          <div className="memory-filter-row" aria-label="Memory filters">
            {FILTERS.map((item) => (
              <button key={item} className={item === filter ? "active" : ""} onClick={() => setFilter(item)}>
                {item}
              </button>
            ))}
          </div>

          <div className="memory-list-heading">
            <span>WIKI INDEX · {filtered.length} {filtered.length === 1 ? "PAGE" : "PAGES"}</span>
            <span>Updated</span>
          </div>

          <div className="memory-list">
            {loading ? <div className="memory-list-empty">Reading Obsidian vault…</div> : null}
            {!loading && filtered.length === 0 ? (
              <div className="memory-list-empty">
                <BrainCircuit size={24} />
                <strong>{memories.length ? "No matches" : "No memories yet"}</strong>
                <span>{memories.length ? "Try a different search or filter." : "Create one when there is something worth remembering."}</span>
              </div>
            ) : null}
            {filtered.map((memory) => (
              <button
                key={memory.id}
                className={memory.id === selectedId && !creating ? "memory-list-item memory-list-item--active" : "memory-list-item"}
                onClick={() => selectMemory(memory.id)}
              >
                <div className="memory-list-item__title"><BrainCircuit size={15} /> <strong>{memory.title}</strong></div>
                <p>{memory.excerpt || "No body text."}</p>
                <div className="memory-list-item__meta">
                  <span>{relativeTime(memory.updatedAt || memory.createdAt)}</span>
                  <span>{memory.tags.slice(0, 2).join(" · ") || "untagged"}</span>
                </div>
              </button>
            ))}
          </div>

        </section>

        <div className={`memory-graph-wrap ${mobileTab === "graph" ? "memory-mobile-active" : ""}`}>
          <Suspense fallback={<div className="memory-graph-loading">Initializing 3D vault…</div>}>
            <MemoryGraph nodes={nodes} edges={edges} selectedId={selectedId} onSelect={selectMemory} onDelete={requestDeletion} />
          </Suspense>
        </div>

        <div className={`memory-editor-wrap ${mobileTab === "edit" ? "memory-mobile-active" : ""}`}>
          <MemoryEditor
            memory={creating ? null : selected}
            creating={creating}
            allMemories={memories}
            onSaved={handleSaved}
            onCancel={() => setCreating(false)}
          />
        </div>

      </div>
    </div>
  );
}

function MobileTabButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}>{icon}{label}</button>;
}

function memoryIdFromHash() {
  const query = window.location.hash.split("?")[1];
  return query ? new URLSearchParams(query).get("id") : null;
}

function relativeTime(value: string) {
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) return "Updated";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatContext(value?: number) {
  if (!value) return "1M";
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value % 1_000_000 ? 2 : 0)}M` : `${Math.round(value / 1_000)}K`;
}
