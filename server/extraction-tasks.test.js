import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  ExtractionTaskError,
  ExtractionTaskStore,
  isDue,
  nextRunDay,
  normalizeTaskInput,
  parseNights,
  travelDates,
} from "./extraction-tasks.js";
import { buildTaskPrompt, ExtractionScheduler, splitSites } from "./extraction-scheduler.js";
import { CSV_HEADERS, toCsvRow } from "./provider-b.js";

const VALID = {
  agentId: "codex",
  destination: "Antalya",
  sites: ["ProviderA"],
  travelStart: "2026-09-01",
  travelEnd: "2026-09-30",
  nights: "7",
  weekdays: ["tue", "fri", "sat"],
  scheduleStart: "2026-09-01",
  scheduleEnd: "2026-09-30",
};

// 2026-09-01 is a Tuesday; the weekday cases below depend on that.
const TUE = new Date("2026-09-01T09:00:00");
const WED = new Date("2026-09-02T09:00:00");

describe("parseNights", () => {
  test("accepts a single length and an inclusive range", () => {
    assert.deepEqual(parseNights("7"), { min: 7, max: 7 });
    assert.deepEqual(parseNights(" 7 - 10 "), { min: 7, max: 10 });
    assert.deepEqual(parseNights(14), { min: 14, max: 14 });
  });

  test("rejects nonsense rather than silently searching the wrong stay", () => {
    for (const bad of ["", "a week", "0", "40", "10-7", "7-", "7,10"]) {
      assert.throws(() => parseNights(bad), ExtractionTaskError, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("travelDates", () => {
  test("expands the range inclusively", () => {
    const dates = travelDates({ travelStart: "2026-09-01", travelEnd: "2026-09-30" });
    assert.equal(dates.length, 30);
    assert.equal(dates[0], "2026-09-01");
    assert.equal(dates.at(-1), "2026-09-30");
  });

  test("restricts to the weekdays flights actually depart on", () => {
    // 1 Sep 2026 is a Tuesday.
    const all = travelDates({ travelStart: "2026-09-01", travelEnd: "2026-09-30" });
    const filtered = travelDates({
      travelStart: "2026-09-01",
      travelEnd: "2026-09-30",
      departureDays: ["tue", "sat"],
    });
    assert.equal(all.length, 30);
    assert.equal(filtered.length, 9, "5 Tuesdays + 4 Saturdays in September 2026");
    assert.equal(filtered[0], "2026-09-01");
    for (const d of filtered) {
      assert.ok([2, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()), `${d} is not Tue/Sat`);
    }
  });

  test("an empty filter means every day, not no days", () => {
    const range = { travelStart: "2026-09-01", travelEnd: "2026-09-07" };
    assert.equal(travelDates({ ...range, departureDays: [] }).length, 7);
    assert.equal(travelDates(range).length, 7);
  });

  test("crosses a month boundary and a single day", () => {
    assert.deepEqual(travelDates({ travelStart: "2026-09-30", travelEnd: "2026-10-02" }), [
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    assert.deepEqual(travelDates({ travelStart: "2026-09-05", travelEnd: "2026-09-05" }), ["2026-09-05"]);
  });
});

describe("normalizeTaskInput", () => {
  test("accepts a full spec and names it from destination and sites", () => {
    const spec = normalizeTaskInput({ ...VALID, sites: ["ProviderA", "ProviderC"], name: "" });
    assert.equal(spec.name, "Antalya · ProviderA vs ProviderC");
    assert.deepEqual(spec.nights, { min: 7, max: 7 });
    assert.deepEqual(spec.weekdays, ["tue", "fri", "sat"]);
  });

  test("orders weekdays canonically however they arrive", () => {
    assert.deepEqual(normalizeTaskInput({ ...VALID, weekdays: ["sat", "tue", "fri"] }).weekdays, [
      "tue",
      "fri",
      "sat",
    ]);
  });

  test("refuses a site with no extraction protocol", () => {
    assert.throws(
      () => normalizeTaskInput({ ...VALID, sites: ["Holiday Hypermarket"] }),
      /Not available yet: Holiday Hypermarket/,
    );
  });

  test("refuses inverted ranges, empty selections and a missing destination", () => {
    assert.throws(() => normalizeTaskInput({ ...VALID, travelEnd: "2026-08-01" }), /on or after travel start/);
    assert.throws(() => normalizeTaskInput({ ...VALID, scheduleEnd: "2026-08-01" }), /on or after schedule start/);
    assert.throws(() => normalizeTaskInput({ ...VALID, weekdays: [] }), /at least one day of the week/);
    assert.throws(() => normalizeTaskInput({ ...VALID, sites: [] }), /at least one website/);
    assert.throws(() => normalizeTaskInput({ ...VALID, agentId: "" }), /Choose an agent/);
    assert.throws(() => normalizeTaskInput({ ...VALID, destination: "  " }), /Destination must be a single line/);
    assert.throws(() => normalizeTaskInput({ ...VALID, travelStart: "01/09/2026" }), /must be a date/);
  });

  test("refuses a travel range too large to be one extraction", () => {
    assert.throws(
      () => normalizeTaskInput({ ...VALID, travelStart: "2026-01-01", travelEnd: "2026-12-31" }),
      /keep it to 120 or fewer/,
    );
  });

  test("the size limit counts what will actually be searched, after filtering", () => {
    // 1 Sep -> 31 Dec is 122 dates, over the cap; Tue/Sat departures is 35.
    const tooBig = { ...VALID, travelStart: "2026-09-01", travelEnd: "2026-12-31" };
    assert.throws(() => normalizeTaskInput(tooBig), /122 departures/);
    const spec = normalizeTaskInput({ ...tooBig, departureDays: ["tue", "sat"] });
    assert.deepEqual(spec.departureDays, ["tue", "sat"]);
  });

  test("refuses a filter that matches no date in the travel range", () => {
    assert.throws(
      // 2026-09-01 is a Tuesday, so a Sunday-only filter over one day matches nothing.
      () =>
        normalizeTaskInput({
          ...VALID,
          travelStart: "2026-09-01",
          travelEnd: "2026-09-01",
          departureDays: ["sun"],
        }),
      /No departure dates match/,
    );
  });
});

describe("isDue", () => {
  const task = { ...normalizeTaskInput(VALID), status: "active", lastRunDay: null };

  test("fires on a selected weekday inside the period", () => {
    assert.equal(isDue(task, TUE), true);
  });

  test("stays quiet on an unselected weekday", () => {
    assert.equal(isDue(task, WED), false);
  });

  test("stays quiet outside the schedule period on both sides", () => {
    assert.equal(isDue(task, new Date("2026-08-25T09:00:00")), false, "before the period (a Tuesday)");
    assert.equal(isDue(task, new Date("2026-10-06T09:00:00")), false, "after the period (a Tuesday)");
  });

  test("fires once per day, not once per tick", () => {
    assert.equal(isDue({ ...task, lastRunDay: "2026-09-01" }, TUE), false);
  });

  test("never fires for a cancelled or completed task", () => {
    assert.equal(isDue({ ...task, status: "cancelled" }, TUE), false);
    assert.equal(isDue({ ...task, status: "completed" }, TUE), false);
  });
});

describe("nextRunDay", () => {
  const task = { ...normalizeTaskInput(VALID), status: "active", lastRunDay: null };

  test("is today when today qualifies", () => {
    assert.equal(nextRunDay(task, TUE), "2026-09-01");
  });

  test("skips to the next selected weekday", () => {
    // Wednesday -> the next selected day is Friday the 4th.
    assert.equal(nextRunDay(task, WED), "2026-09-04");
  });

  test("looks past today once today has already fired", () => {
    assert.equal(nextRunDay({ ...task, lastRunDay: "2026-09-01" }, TUE), "2026-09-04");
  });

  test("is null once the period is spent", () => {
    assert.equal(nextRunDay(task, new Date("2026-10-06T09:00:00")), null);
  });
});

describe("buildTaskPrompt", () => {
  test("names every parameter so an unattended run cannot drift", () => {
    const task = { ...normalizeTaskInput({ ...VALID, nights: "7-10" }), id: "t1" };
    const prompt = buildTaskPrompt(task);
    assert.match(prompt, /Destination: Antalya/);
    assert.match(prompt, /Sites: ProviderA/);
    assert.match(prompt, /2026-09-01 to 2026-09-30 \(30 departure dates/);
    assert.match(prompt, /Nights: 7-10/);
    assert.match(prompt, /lib\/extraction-runtime\.js/);
  });

  test("counts a single departure date in the singular", () => {
    const one = buildTaskPrompt({
      ...normalizeTaskInput({ ...VALID, travelStart: "2026-09-01", travelEnd: "2026-09-01" }),
      id: "t3",
    });
    assert.match(one, /\(1 departure date, /);
  });

  test("gives an absolute workspace path, not one resolved against $HOME", () => {
    // A bare "Extraction_Live_Workspace/..." was resolved against $HOME and the
    // output landed outside the shared workspace, invisible to everything.
    const prompt = buildTaskPrompt({ ...normalizeTaskInput(VALID), id: "t7" }, "2026-08-09");
    assert.match(prompt, /~\/\.openclaw\/workspace\/Extraction_Live_Workspace\/2026-08-09\//);
    assert.match(prompt, /one results-<date>\.csv per departure date \(30 of them\)/);
    assert.match(prompt, /absolute session folder path/);
  });

  test("tells the agent which departure weekdays were selected", () => {
    const filtered = buildTaskPrompt({
      ...normalizeTaskInput({ ...VALID, departureDays: ["tue", "sat"] }),
      id: "t5",
    });
    assert.match(filtered, /Tuesday\/Saturday departures only/);
    // 5 Tuesdays + 4 Saturdays in September 2026.
    assert.match(filtered, /\(9 departure dates/);
    const unfiltered = buildTaskPrompt({ ...normalizeTaskInput(VALID), id: "t6" });
    assert.match(unfiltered, /every date in range/);
  });

  test("never asks the agent to extract a site the BFF owns", () => {
    const prompt = buildTaskPrompt({
      ...normalizeTaskInput({ ...VALID, sites: ["ProviderA", "ProviderB"] }),
      id: "t4",
    });
    assert.match(prompt, /Sites: ProviderA/);
    assert.match(prompt, /Jarvis extracts ProviderB itself; do not attempt it/);
    assert.equal(/Sites: .*ProviderB and/.test(prompt), false);
  });

  test("asks for the comparison step only when more than one site is selected", () => {
    const single = buildTaskPrompt({ ...normalizeTaskInput(VALID), id: "t1" });
    const paired = buildTaskPrompt({
      ...normalizeTaskInput({ ...VALID, sites: ["ProviderA", "ProviderC"] }),
      id: "t2",
    });
    assert.equal(/comparison CSV/.test(single), false);
    assert.match(paired, /comparison CSV/);
    assert.match(paired, /Sites: ProviderA and ProviderC/);
  });
});

describe("unified CSV schema", () => {
  test("carries a separate rank column per platform", () => {
    assert.deepEqual(CSV_HEADERS.slice(3, 6), ["ProviderA Rank", "ProviderC Rank", "ProviderB Rank"]);
    assert.equal(CSV_HEADERS.length, 13);
  });

  test("a ProviderB row fills only its own rank", () => {
    const item = {
      kind: "package",
      hotelName: "Sun Star Resort",
      nights: 7,
      boardBasisCode: "AI",
      pricePerPersonMinor: 42900,
      airlineName: "Example Air",
      destinationLabel: "Antalya",
    };
    const row = toCsvRow(item, {
      travelDate: "2026-09-15",
      scrapeTime: "08/08/2026 18:55",
      destination: "Antalya",
      nights: 7,
      rank: 12,
    });
    const byName = Object.fromEntries(CSV_HEADERS.map((h, i) => [h, row[i]]));
    assert.equal(byName["ProviderB Rank"], 12);
    assert.equal(byName["ProviderA Rank"], "", "ProviderA rank must stay blank");
    assert.equal(byName["ProviderC Rank"], "", "ProviderC rank is not ours to fill");
    // perPerson is pence.
    assert.equal(byName["Price Per Person"], 429);
    assert.equal(byName["Hotel Name"], "Sun Star Resort");
    assert.equal(byName["Airline"], "Example Air");
    assert.equal(byName["Destination"], "Antalya");
    assert.equal(row.length, CSV_HEADERS.length);
  });
});

describe("splitSites", () => {
  test("separates what the agent extracts from what the BFF must", () => {
    assert.deepEqual(splitSites(["ProviderA", "ProviderB", "ProviderD"]), {
      agentSites: ["ProviderA", "ProviderD"],
      bffSites: ["ProviderB"],
    });
  });

  test("a ProviderB-only task leaves the agent nothing to do", () => {
    assert.deepEqual(splitSites(["ProviderB"]), { agentSites: [], bffSites: ["ProviderB"] });
  });
});

describe("ExtractionTaskStore", () => {
  let dir;
  let store;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tasks-"));
    store = new ExtractionTaskStore(path.join(dir, "test.sqlite"));
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("round-trips a task", () => {
    const created = store.create(VALID);
    assert.equal(created.status, "active");
    assert.equal(created.runCount, 0);
    assert.deepEqual(store.get(created.id).weekdays, ["tue", "fri", "sat"]);
    assert.equal(store.list().length, 1);
  });

  test("claiming a day is atomic, so a task cannot fire twice on one day", () => {
    const task = store.create(VALID);
    assert.ok(store.claimRun(task.id, "2026-09-01"));
    assert.equal(store.claimRun(task.id, "2026-09-01"), null, "second claim for the same day must fail");
    assert.equal(store.get(task.id).runCount, 1);
    assert.ok(store.claimRun(task.id, "2026-09-04"), "a new day may be claimed");
  });

  test("a cancelled task cannot be claimed", () => {
    const task = store.create(VALID);
    store.setStatus(task.id, "cancelled");
    assert.equal(store.claimRun(task.id, "2026-09-01"), null);
  });

  test("startRun marks the agent working and finishRun clears it with the reply", () => {
    const task = store.create(VALID);
    assert.equal(store.get(task.id).runningSince, null);

    const started = store.startRun(task.id);
    assert.ok(started.runningSince, "a dispatched task must be visibly working");
    assert.ok(started.lastRunAt, "a manual run must record when it started");
    assert.equal(started.lastRunDetail, null, "the previous run's reply must not linger");

    const finished = store.finishRun(task.id, "ProviderA: 202 rows.");
    assert.equal(finished.runningSince, null);
    assert.match(finished.lastRunDetail, /202 rows/);
  });

  test("a run interrupted by a restart is recovered, not left working forever", () => {
    const task = store.create(VALID);
    store.startRun(task.id);
    assert.equal(store.recoverInterruptedRuns(), 1);
    const recovered = store.get(task.id);
    assert.equal(recovered.runningSince, null);
    assert.match(recovered.lastRunDetail, /interrupted/);
    // Nothing left running means a second recovery pass has no work to do.
    assert.equal(store.recoverInterruptedRuns(), 0);
  });

  test("expire completes tasks whose period has passed, and leaves live ones alone", () => {
    const past = store.create({ ...VALID, scheduleStart: "2026-07-01", scheduleEnd: "2026-07-31" });
    const live = store.create(VALID);
    store.expire(new Date("2026-09-01T09:00:00"));
    assert.equal(store.get(past.id).status, "completed");
    assert.equal(store.get(live.id).status, "active");
  });
});

describe("ExtractionScheduler", () => {
  let dir;
  let store;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-sched-"));
    store = new ExtractionTaskStore(path.join(dir, "sched.sqlite"));
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  function schedulerFor(now, sent) {
    return new ExtractionScheduler({
      store,
      now: () => now,
      // Stand in for the agent turn: record what would have been sent.
      dispatch: async (task) => {
        sent.push({ id: task.id, prompt: buildTaskPrompt(task) });
        return "done";
      },
    });
  }

  test("dispatches a due task once, then not again on the same day", async () => {
    const task = store.create(VALID);
    const sent = [];
    const scheduler = schedulerFor(TUE, sent);
    const first = await scheduler.tick();
    assert.equal(first.length, 1);
    assert.equal(first[0].id, task.id);

    const second = await scheduler.tick();
    assert.equal(second.length, 0, "the claimed day must not be dispatched twice");
    assert.equal(sent.length, 1, "the agent must be asked exactly once");
    assert.match(sent[0].prompt, /Destination: Antalya/);
    // The dispatch is recorded, so the card can show it rather than looking idle.
    assert.ok(store.get(task.id).lastRunAt);
    store.setStatus(task.id, "cancelled");
  });

  test("ignores tasks whose weekday does not match", async () => {
    const task = store.create(VALID);
    const scheduler = schedulerFor(WED, []);
    assert.equal((await scheduler.tick()).length, 0);
    store.setStatus(task.id, "cancelled");
  });

  test("flags a site whose reported output never reached the workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-verify-"));
    const day = "2026-08-09";
    const dayDir = path.join(root, "Extraction_Live_Workspace", day);
    // ProviderD landed; ProviderA was claimed but never written.
    fs.mkdirSync(path.join(dayDir, "hurghada-providerD-sept-dec_2328"), { recursive: true });
    fs.writeFileSync(path.join(dayDir, "hurghada-providerD-sept-dec_2328", "results-2026-09-01.csv"), "a\n");
    const scheduler = new ExtractionScheduler({ store, workspaceRoot: root, now: () => TUE });

    const notes = scheduler.verifyAgentOutputForTest(["ProviderD", "ProviderA"], day);
    assert.match(notes[0], /ProviderD: hurghada-providerD-sept-dec_2328 — 1 date CSVs on disk/);
    assert.match(notes[1], /⚠️ ProviderA: no session folder/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("aborting a task stops treating it as in flight", async () => {
    const task = store.create(VALID);
    const scheduler = schedulerFor(TUE, []);
    scheduler.inFlight.add(task.id);
    // Whether the gateway had a live turn to cancel is not the point: the task
    // must stop being treated as in flight either way, so a later tick can act.
    await scheduler.abort(task);
    assert.equal(scheduler.inFlight.has(task.id), false);
    assert.equal(await scheduler.abort(null), false, "no task is a no-op, not a crash");
    store.setStatus(task.id, "cancelled");
  });

  test("a tick expires spent tasks before looking for work", async () => {
    const past = store.create({ ...VALID, scheduleStart: "2026-07-01", scheduleEnd: "2026-07-31" });
    await schedulerFor(TUE, []).tick();
    assert.equal(store.get(past.id).status, "completed");
  });
});
