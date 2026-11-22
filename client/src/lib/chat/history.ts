import { foldTool, type RunActivity } from "./workspace";
import { textFromMessage } from "./messages";

interface HistoryBlock {
  text?: string;
  type?: string;
  id?: string;
  name?: string;
  arguments?: { command?: string; path?: string; file_path?: string };
}
interface HistoryEntry {
  role?: string;
  timestamp?: string | number;
  runId?: string;
  content?: HistoryBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/** A transcript can omit run IDs. A user turn then bounds its assistant and tool messages. */
export function historyActivity(
  messages: HistoryEntry[],
  sessionKey: string,
  active: boolean,
) {
  let runs: RunActivity[] = [];
  let id = "";
  let start: number | undefined;
  const calls = new Map<string, string>();
  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== "object") continue;
    const time =
      message.timestamp == null ? NaN : new Date(message.timestamp).getTime();
    if (!Number.isFinite(time)) continue;
    if (message.role === "user") {
      id = "history-" + index;
      start = time;
      continue;
    }
    if (message.role !== "assistant" && message.role !== "toolResult") continue;
    id =
      message.runId ??
      (message.toolCallId && calls.get(message.toolCallId)) ??
      (id || "history-" + index);
    let run = runs.find((r) => r.id === id);
    if (!run) {
      run = { id, time: start ?? time, tools: [] };
      runs.push(run);
    }
    if (message.role === "toolResult" && message.toolCallId) {
      const call = run.tools.find((t) => t.toolCallId === message.toolCallId);
      runs = foldTool(
        runs,
        {
          ...call,
          sessionKey,
          runId: id,
          toolCallId: message.toolCallId,
          name: message.toolName ?? call?.name ?? "Tool",
          startedAt: call?.startedAt ?? time,
          endedAt: time,
          status: message.isError ? "error" : "done",
          output: new TextDecoder().decode(
            new TextEncoder().encode(textFromMessage(message)).slice(0, 4096),
          ),
        },
        id,
      );
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== "toolCall" || !block.id) continue;
        calls.set(block.id, id);
        const args = block.arguments;
        const path = args?.path ?? args?.file_path;
        runs = foldTool(
          runs,
          {
            sessionKey,
            runId: id,
            toolCallId: block.id,
            name: block.name ?? "Tool",
            status: "running",
            startedAt: time,
            ...(typeof args?.command === "string" && { command: args.command }),
            ...(typeof path === "string" && { paths: [path] }),
          },
          id,
        );
      }
    }
    runs = runs.map((r) => (r.id === id ? { ...r, endedAt: time } : r));
  }
  if (active)
    runs = runs.map((r) => (r.id === id ? { ...r, endedAt: undefined } : r));
  return runs;
}
