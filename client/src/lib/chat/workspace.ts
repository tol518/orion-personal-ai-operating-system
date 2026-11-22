export interface ToolEvent {
  sessionKey: string;
  runId?: string;
  toolCallId: string;
  name: string;
  status: "running" | "done" | "error";
  startedAt: number;
  endedAt?: number;
  summary?: string;
  command?: string;
  output?: string;
  paths?: string[];
}

export interface RunActivity {
  id: string;
  time: number;
  endedAt?: number;
  tools: ToolEvent[];
}

export type Decision = "allow-once" | "allow-always" | "deny";
export interface Approval {
  id: string;
  sessionKey?: string;
  command: string;
  cwd?: string;
  host?: string;
  requestedAt: number;
  expiresAt?: number;
  status: "pending" | "approved" | "denied" | "expired";
}

const pad = (n: number) => String(n).padStart(2, "0");

export function timeLabel(time: number, now = new Date()) {
  const date = new Date(time);
  const clock = pad(date.getHours()) + ":" + pad(date.getMinutes());
  if (date.toDateString() === now.toDateString()) return clock;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return "Yesterday " + clock;
  return (
    date.getDate() +
    " " +
    date.toLocaleDateString("en-GB", { month: "short" }) +
    " " +
    clock
  );
}

export function screenshotName(date: Date, number = 1) {
  const stamp =
    date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
  return (
    "screenshot-" +
    stamp +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds()) +
    (number > 1 ? "-" + number : "") +
    ".png"
  );
}

export function followBottom(height: number, top: number, viewport: number) {
  return height - top - viewport <= 80;
}

export function composerKey(key: string, shift: boolean, composing: boolean) {
  if (composing) return;
  if (key === "Enter" && !shift) return "send";
  if (key === "Escape") return "stop";
}

export function thinkingLevels(session?: {
  thinkingOptions?: string[];
  thinkingLevels?: (string | { id: string })[];
  supportsThinking?: boolean;
  thinkingLevel?: string;
}) {
  if (session?.supportsThinking === false) return [];
  const reported =
    session?.thinkingOptions ??
    session?.thinkingLevels?.map((level) =>
      typeof level === "string" ? level : level.id,
    );
  if (reported)
    return reported.some((level) => level !== "off") ? reported : [];
  return [
    ...new Set([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      ...(session?.thinkingLevel ? [session.thinkingLevel] : []),
    ]),
  ];
}

export function foldTool(
  runs: RunActivity[],
  event: ToolEvent,
  id = event.runId ?? event.sessionKey,
): RunActivity[] {
  const run = runs.find((run) => run.id === id) ?? {
    id,
    time: event.startedAt,
    tools: [],
  };
  const old = run.tools.find((tool) => tool.toolCallId === event.toolCallId);
  const tool = {
    ...old,
    ...event,
    startedAt: old?.startedAt ?? event.startedAt,
  };
  const tools = old
    ? run.tools.map((item) => (item === old ? tool : item))
    : [...run.tools, tool];
  return [...runs.filter((item) => item.id !== id), { ...run, tools }];
}

export function mergeTimeline<T extends { time: number }>(
  ...groups: T[][]
): T[] {
  return groups.flat().sort((a, b) => a.time - b.time);
}
