import { describe, expect, it } from "vitest";
import {
  timeLabel,
  screenshotName,
  mergeTimeline,
  foldTool,
  thinkingLevels,
  followBottom,
  composerKey,
  type ToolEvent,
} from "./workspace";

describe("chat workspace", () => {
  it("labels local calendar days across month boundaries", () => {
    const now = new Date(2026, 2, 1, 14, 0);
    expect(timeLabel(+new Date(2026, 2, 1, 9, 5), now)).toBe("09:05");
    expect(timeLabel(+new Date(2026, 1, 28, 23, 55), now)).toBe(
      "Yesterday 23:55",
    );
    expect(timeLabel(+new Date(2026, 1, 16, 8, 5), now)).toBe("16 Feb 08:05");
  });
  it("names screenshots in a single paste", () => {
    const stamp = new Date(2026, 3, 2, 9, 4, 7);
    expect(screenshotName(stamp)).toBe("screenshot-20260402-090407.png");
    expect(screenshotName(stamp, 2)).toBe("screenshot-20260402-090407-2.png");
  });
  it("merges timeline entries chronologically and keeps ties stable", () => {
    const a = { time: 1, id: "a" },
      b = { time: 1, id: "b" },
      c = { time: 3, id: "c" };
    expect(mergeTimeline([a, c], [b])).toEqual([a, b, c]);
  });
  it("folds tool updates without losing paths or duplicating calls", () => {
    const start: ToolEvent = {
      sessionKey: "s",
      runId: "r",
      toolCallId: "c",
      startedAt: 1,
      name: "read",
      status: "running",
      paths: ["notes"],
    };
    const runs = foldTool([], start);
    const next = foldTool(runs, {
      ...start,
      status: "done",
      endedAt: 5,
      output: "ok",
    });
    expect(next).toHaveLength(1);
    expect(next[0].tools).toEqual([
      { ...start, status: "done", endedAt: 5, output: "ok" },
    ]);
    expect(runs[0].tools[0].status).toBe("running");
  });
  it("uses provider thinking options and respects disabled reasoning", () => {
    expect(thinkingLevels({ supportsThinking: false })).toEqual([]);
    expect(
      thinkingLevels({ thinkingLevels: [{ id: "off" }, { id: "adaptive" }] }),
    ).toEqual(["off", "adaptive"]);
    expect(thinkingLevels({ thinkingOptions: ["off"] })).toEqual([]);
    expect(thinkingLevels()).not.toContain("xhigh");
  });
  it("follows output within eighty pixels", () => {
    expect(followBottom(1000, 320, 600)).toBe(true);
    expect(followBottom(1000, 319, 600)).toBe(false);
  });
  it("handles send, newline, stop and input method composition", () => {
    expect(composerKey("Enter", false, false)).toBe("send");
    expect(composerKey("Enter", true, false)).toBeUndefined();
    expect(composerKey("Escape", false, false)).toBe("stop");
    expect(composerKey("Enter", false, true)).toBeUndefined();
    expect(composerKey("Escape", false, true)).toBeUndefined();
  });
});

import { historyActivity } from "./history";
it("restores command details and elapsed time from a transcript", () => {
  const runs = historyActivity(
    [
      { role: "user", timestamp: 100 },
      {
        role: "assistant",
        timestamp: 101,
        content: [
          {
            type: "toolCall",
            name: "exec",
            id: "c",
            arguments: { command: "pwd" },
          },
        ],
      },
      {
        role: "toolResult",
        timestamp: 103,
        toolCallId: "c",
        content: [{ type: "text", text: "/notes" }],
      },
      { role: "assistant", timestamp: 105 },
    ],
    "s",
    false,
  );
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    time: 100,
    endedAt: 105,
    tools: [{ name: "exec", command: "pwd", status: "done", output: "/notes" }],
  });
});
