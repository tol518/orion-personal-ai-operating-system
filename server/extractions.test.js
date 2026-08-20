import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { ExtractionCatalog, isWindowOpen, msUntilWindowOpens, __testing } from "./extractions.js";

const { parseCsv, platformOf, encodeId, normalizeSchedule, RUN_FILE, CONTROL_FILE, DEFAULT_SCHEDULE_FILE } =
  __testing;

describe("parseCsv", () => {
  test("handles quoted commas, escaped quotes and trailing newline", () => {
    const rows = parseCsv('"a","b"\n"Hotel, Grand","He said ""hi"""\n');
    assert.deepEqual(rows, [
      ["a", "b"],
      ["Hotel, Grand", 'He said "hi"'],
    ]);
  });

  test("drops fully blank lines", () => {
    assert.equal(parseCsv("a,b\n\n1,2\n").length, 2);
  });
});

describe("platformOf", () => {
  test("labels known platforms and flags multi-platform files", () => {
    assert.equal(platformOf("2026-08-06/provider-a-antalya/results.csv"), "ProviderA");
    assert.equal(platformOf("provider-c-antalya-june.csv"), "ProviderC");
    assert.equal(platformOf("provider-e-antalya-manual.csv"), "ProviderE");
    assert.equal(platformOf("2026-08-06/provider-d-antalya/results.csv"), "ProviderD");
    assert.equal(platformOf("provider-b-antalya-sept.csv"), "ProviderB");
    assert.equal(platformOf("provider-c-provider-a-bodrum-combined.csv"), "Multi");
    assert.equal(platformOf("random-notes.csv"), "Unknown");
    // Filename beats folder: this file holds only ProviderA rows.
    assert.equal(platformOf("provider-a-provider-c-batches/provider-a.csv"), "ProviderA");
    assert.equal(platformOf("provider-a-provider-c-batches/comparison.csv"), "Multi");
  });
});

describe("ExtractionCatalog", () => {
  let root;
  let catalog;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-extractions-"));
    fs.mkdirSync(path.join(root, "Extraction_Live_Workspace", "2026-08-06", "provider-a-example-coast_1419"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, "Extraction_Live_Workspace", "2026-08-06", "provider-a-example-coast_1419", "results-2026-09-15.csv"),
      '"Hotel Name","Price Per Person"\n"Sample Resort","422"\n',
    );
    fs.mkdirSync(path.join(root, "Extraction_Live_Workspace", "legacy-batches"), { recursive: true });
    fs.writeFileSync(path.join(root, "Extraction_Live_Workspace", "legacy-batches", "batch.csv"), '"a"\n"1"\n');
    fs.writeFileSync(path.join(root, "ANTALYA-FINAL.csv"), '"a"\n"1"\n');
    fs.writeFileSync(path.join(root, "notes.md"), "ignored");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "dep.csv"), "x\n");
    catalog = new ExtractionCatalog({ root });
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("lists session CSVs with day/session context and root-level CSVs", () => {
    const listed = catalog.list();
    const session = listed.find((entry) => entry.name === "results-2026-09-15.csv");
    assert.ok(session);
    assert.equal(session.day, "2026-08-06");
    assert.equal(session.session, "provider-a-example-coast_1419");
    assert.equal(session.platform, "ProviderA");
    const undated = listed.find((entry) => entry.name === "batch.csv");
    assert.equal(undated.day, null);
    assert.equal(undated.session, "legacy-batches");
    const rootFile = listed.find((entry) => entry.name === "ANTALYA-FINAL.csv");
    assert.ok(rootFile);
    assert.equal(rootFile.day, null);
    assert.equal(listed.some((entry) => entry.name === "notes.md"), false);
  });

  test("does not descend into sibling directories of the workspace root", () => {
    // Root scan is depth 0, so a stray node_modules cannot flood the catalogue.
    assert.equal(catalog.list().some((entry) => entry.relPath.includes("node_modules")), false);
  });

  test("reads a CSV into columns and rows", () => {
    const target = catalog.list().find((entry) => entry.name === "results-2026-09-15.csv");
    const detail = catalog.read(target.id);
    assert.deepEqual(detail.columns, ["Hotel Name", "Price Per Person"]);
    assert.deepEqual(detail.rows, [["Sample Resort", "422"]]);
    assert.equal(detail.totalRows, 1);
    assert.equal(detail.truncated, false);
  });

  test("truncates the preview at the requested limit but reports the real count", () => {
    const target = catalog.list().find((entry) => entry.name === "results-2026-09-15.csv");
    const detail = catalog.read(target.id, { limit: 0 });
    assert.equal(detail.rows.length, 0);
    assert.equal(detail.totalRows, 1);
    assert.equal(detail.truncated, true);
  });

  test("refuses ids escaping the workspace, non-CSV ids and junk ids", () => {
    assert.equal(catalog.resolve(encodeId("../../etc/passwd.csv")), null);
    assert.equal(catalog.resolve(encodeId("notes.md")), null);
    assert.equal(catalog.read(encodeId("Extraction_Live_Workspace/missing.csv")), null);
  });
});

describe("ExtractionCatalog.runs", () => {
  let root;
  let catalog;
  const DATES = ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];
  const STARTED = "2026-08-06T14:00:00.000Z";
  const NOW = Date.parse("2026-08-06T14:10:00.000Z");

  function seedRun(name, plan, extractedDates) {
    const dir = path.join(root, "Extraction_Live_Workspace", "2026-08-06", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, RUN_FILE), JSON.stringify(plan));
    for (const date of extractedDates) {
      fs.writeFileSync(path.join(dir, `results-${date}.csv`), '"a"\n"1"\n');
    }
    // Pin mtimes to the suite's injected clock; real wall-clock mtimes would
    // sit in NOW's future and read as activity that never happened.
    setSessionMtime(name, 0);
    return dir;
  }

  /** Move a session's writes `minutes` before the suite's NOW. */
  function setSessionMtime(name, minutes) {
    const dir = path.join(root, "Extraction_Live_Workspace", "2026-08-06", name);
    const when = new Date(NOW - minutes * 60_000);
    for (const entry of [path.join(dir, RUN_FILE), dir]) fs.utimesSync(entry, when, when);
  }

  const ageSession = setSessionMtime;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-runs-"));
    catalog = new ExtractionCatalog({ root });
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("counts extracted and remaining dates and names the current one", () => {
    seedRun(
      "antalya-provider-a_1400",
      { platform: "ProviderA", destination: "Antalya", nights: 7, dates: DATES, startedAt: STARTED, pid: process.pid },
      DATES.slice(0, 2),
    );
    const run = catalog.runs({ now: NOW }).find((entry) => entry.session === "antalya-provider-a_1400");
    assert.equal(run.status, "running");
    assert.equal(run.totalDates, 4);
    assert.equal(run.extractedDates, 2);
    assert.equal(run.remainingDates, 2);
    assert.equal(run.currentDate, "2026-09-17");
    assert.equal(run.elapsedMs, 10 * 60 * 1000);
    // 10 min bought 2 dates, so the 2 that are left are worth another 10.
    assert.equal(run.etaMs, 10 * 60 * 1000);
  });

  test("a live pid with no dates done yet reports no eta", () => {
    seedRun("bodrum-provider-a_1400", { dates: DATES, startedAt: STARTED, pid: process.pid }, []);
    const run = catalog.runs({ now: NOW }).find((entry) => entry.session === "bodrum-provider-a_1400");
    assert.equal(run.extractedDates, 0);
    assert.equal(run.currentDate, "2026-09-15");
    assert.equal(run.etaMs, null);
  });

  test("an unknown pid still writing files is alive, not stalled", () => {
    // The sandbox case: an agent records a pid from its own namespace, so the
    // pid is invisible here even though the run is plainly still working.
    seedRun("sandbox-provider-a_1400", { dates: DATES, startedAt: STARTED, pid: 999_999 }, DATES.slice(0, 1));
    const run = catalog.runs({ now: NOW }).find((entry) => entry.session === "sandbox-provider-a_1400");
    assert.equal(run.status, "running");
    assert.equal(run.controllable, true, "a live run must stay pausable and stoppable");
  });

  test("an unknown pid that has stopped writing is stalled", () => {
    seedRun("izmir-provider-a_1400", { dates: DATES, startedAt: STARTED, pid: 999_999 }, DATES.slice(0, 1));
    ageSession("izmir-provider-a_1400", 10);
    const run = catalog.runs({ now: NOW }).find((entry) => entry.session === "izmir-provider-a_1400");
    assert.equal(run.status, "stalled");
    assert.equal(run.remainingDates, 3);
    assert.equal(run.controllable, false);
    // A run that is not going to finish must not advertise a finish time.
    assert.equal(run.etaMs, null);
  });

  test("a run that has just finished is not controllable, however recent its writes", () => {
    // It still looks alive by file recency, but there is nothing left to command.
    seedRun("justdone-provider-a_1400", { dates: DATES, startedAt: STARTED, pid: 999_999 }, DATES);
    const run = catalog.runs({ now: NOW }).find((entry) => entry.session === "justdone-provider-a_1400");
    assert.equal(run.status, "complete");
    assert.equal(run.controllable, false);
  });

  test("status and controllability never disagree", () => {
    // The bug this guards: a run reported as still going while Pause and Stop
    // were disabled, leaving no way to act on it.
    for (const run of catalog.runs({ now: NOW })) {
      const activeStatus = ["running", "paused", "waiting"].includes(run.status);
      assert.equal(
        run.controllable,
        activeStatus,
        `${run.session} is ${run.status} but controllable=${run.controllable}`,
      );
    }
  });

  test("a fresh heartbeat keeps a quiet run alive when nothing is being written", () => {
    // Paused and waiting runs produce no files, so only the heartbeat vouches.
    seedRun(
      "held-provider-a_1400",
      { dates: DATES, startedAt: STARTED, pid: 999_999, state: "paused", heartbeatAt: new Date(NOW - 5000).toISOString() },
      [],
    );
    ageSession("held-provider-a_1400", 10);
    const run = catalog.runs({ now: NOW }).find((entry) => entry.session === "held-provider-a_1400");
    assert.equal(run.status, "paused");
    assert.equal(run.controllable, true);
  });

  test("finishedAt freezes elapsed and clears the eta", () => {
    seedRun(
      "dalaman-provider-a_1400",
      { dates: DATES, startedAt: STARTED, finishedAt: "2026-08-06T14:05:00.000Z", pid: 999_999 },
      DATES,
    );
    const run = catalog.runs({ now: NOW }).find((entry) => entry.session === "dalaman-provider-a_1400");
    assert.equal(run.status, "complete");
    assert.equal(run.remainingDates, 0);
    assert.equal(run.elapsedMs, 5 * 60 * 1000);
    assert.equal(run.etaMs, null);
  });

  test("every date extracted is complete even without a finishedAt stamp", () => {
    seedRun("kos-provider-a_1400", { dates: DATES, startedAt: STARTED, pid: process.pid }, DATES);
    const run = catalog.runs({ now: NOW }).find((entry) => entry.session === "kos-provider-a_1400");
    assert.equal(run.status, "complete");
  });

  test("ignores sessions with no run file, an unreadable one, or no dates", () => {
    const bare = path.join(root, "Extraction_Live_Workspace", "2026-08-06", "no-plan_1400");
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, "results-2026-09-15.csv"), '"a"\n');
    seedRun("broken_1400", {}, []);
    fs.writeFileSync(
      path.join(root, "Extraction_Live_Workspace", "2026-08-06", "broken_1400", RUN_FILE),
      "{not json",
    );
    seedRun("empty-dates_1400", { dates: [], startedAt: STARTED }, []);
    const sessions = catalog.runs({ now: NOW }).map((entry) => entry.session);
    assert.equal(sessions.includes("no-plan_1400"), false);
    assert.equal(sessions.includes("broken_1400"), false);
    assert.equal(sessions.includes("empty-dates_1400"), false);
  });
});

describe("normalizeSchedule", () => {
  const anytime = { mode: "anytime", start: null, end: null };

  test("keeps a usable window", () => {
    assert.deepEqual(normalizeSchedule({ mode: "window", start: "00:00", end: "08:00" }), {
      mode: "window",
      start: "00:00",
      end: "08:00",
    });
  });

  test("degrades anything unusable to anytime rather than trapping the run", () => {
    assert.deepEqual(normalizeSchedule(undefined), anytime);
    assert.deepEqual(normalizeSchedule({ mode: "window" }), anytime);
    assert.deepEqual(normalizeSchedule({ mode: "window", start: "8am", end: "17:00" }), anytime);
    assert.deepEqual(normalizeSchedule({ mode: "window", start: "24:00", end: "08:00" }), anytime);
    assert.deepEqual(normalizeSchedule({ mode: "window", start: "08:00", end: "08:00" }), anytime);
  });
});

describe("run window", () => {
  const at = (hhmm) => new Date(`2026-08-09T${hhmm}:00`);
  const overnight = { mode: "window", start: "00:00", end: "08:00" };
  const wrapping = { mode: "window", start: "22:00", end: "06:00" };

  test("anytime is always open", () => {
    assert.equal(isWindowOpen({ mode: "anytime" }, at("22:05")), true);
  });

  test("a same-day window is closed outside its hours", () => {
    // The case that shipped broken: a run fired at 22:05 under a 00:00-08:00
    // window and extracted straight through it.
    assert.equal(isWindowOpen(overnight, at("22:05")), false);
    assert.equal(isWindowOpen(overnight, at("00:28")), true);
    assert.equal(isWindowOpen(overnight, at("08:00")), false);
  });

  test("a window crossing midnight stays open through it", () => {
    assert.equal(isWindowOpen(wrapping, at("23:59")), true);
    assert.equal(isWindowOpen(wrapping, at("00:30")), true);
    assert.equal(isWindowOpen(wrapping, at("07:00")), false);
  });

  test("reports how long until the window reopens", () => {
    assert.equal(msUntilWindowOpens(overnight, at("03:00")), 0);
    // 22:05 -> next midnight is 1h55m away.
    assert.equal(msUntilWindowOpens(overnight, at("22:05")), (60 + 55) * 60_000);
  });
});

describe("ExtractionCatalog control", () => {
  let root;
  let catalog;
  let sessionDir;
  const DATES = ["2026-09-15", "2026-09-16"];

  function runId() {
    return catalog.runs()[0].id;
  }

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-control-"));
    sessionDir = path.join(root, "Extraction_Live_Workspace", "2026-08-06", "antalya-provider-a_1400");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, RUN_FILE),
      // pid 999999 keeps the test from signalling a real process.
      JSON.stringify({ dates: DATES, startedAt: new Date().toISOString(), pid: 999_999, state: "running" }),
    );
    catalog = new ExtractionCatalog({ root });
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("writes the operator's command where the script polls for it", () => {
    const run = catalog.control(runId(), { command: "pause" });
    assert.equal(run.command, "pause");
    assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, CONTROL_FILE), "utf8")).command, "pause");
  });

  test("setting a window leaves the command alone, and vice versa", () => {
    catalog.control(runId(), { schedule: { mode: "window", start: "00:00", end: "08:00" } });
    let run = catalog.runs()[0];
    assert.equal(run.command, "pause", "schedule edit must not silently resume a paused run");
    assert.deepEqual(run.schedule, { mode: "window", start: "00:00", end: "08:00" });

    run = catalog.control(runId(), { command: "run" });
    assert.equal(run.command, "run");
    assert.deepEqual(run.schedule, { mode: "window", start: "00:00", end: "08:00" }, "window must survive resume");
  });

  test("an unusable window is stored as anytime", () => {
    const run = catalog.control(runId(), { schedule: { mode: "window", start: "nope", end: "08:00" } });
    assert.deepEqual(run.schedule, { mode: "anytime", start: null, end: null });
  });

  test("stop becomes terminal immediately, even if the script has already disappeared", () => {
    const run = catalog.control(runId(), { command: "stop" });
    const plan = JSON.parse(fs.readFileSync(path.join(sessionDir, RUN_FILE), "utf8"));
    assert.equal(run.status, "stopped");
    assert.equal(run.controllable, false);
    assert.equal(plan.state, "stopped");
    assert.ok(plan.finishedAt);
  });

  test("a stopped script reports stopped, not complete, with dates left", () => {
    fs.writeFileSync(
      path.join(sessionDir, RUN_FILE),
      JSON.stringify({
        dates: DATES,
        startedAt: new Date().toISOString(),
        pid: 999_999,
        state: "stopped",
        finishedAt: new Date().toISOString(),
      }),
    );
    const run = catalog.runs()[0];
    assert.equal(run.status, "stopped");
    assert.equal(run.remainingDates, 2);
    assert.equal(run.etaMs, null);
  });

  test("paused and waiting are held states, not stalls, while the script lives", () => {
    for (const state of ["paused", "waiting"]) {
      fs.writeFileSync(
        path.join(sessionDir, RUN_FILE),
        JSON.stringify({ dates: DATES, startedAt: new Date().toISOString(), pid: process.pid, state }),
      );
      const run = catalog.runs()[0];
      assert.equal(run.status, state);
      assert.equal(run.etaMs, null, "a held run must not promise a finish time");
    }
  });

  test("a silent script with a stale heartbeat outranks its own last reported state", () => {
    fs.writeFileSync(
      path.join(sessionDir, RUN_FILE),
      JSON.stringify({
        dates: DATES,
        startedAt: new Date().toISOString(),
        pid: 999_999,
        state: "paused",
        heartbeatAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      }),
    );
    const old = new Date(Date.now() - 30 * 60_000);
    for (const entry of [path.join(sessionDir, RUN_FILE), sessionDir]) fs.utimesSync(entry, old, old);
    const run = catalog.runs()[0];
    assert.equal(run.status, "stalled");
    assert.equal(run.controllable, false);
  });

  test("refuses control of ids that are not real runs", () => {
    assert.equal(catalog.control(encodeId("../../etc"), { command: "stop" }), null);
    assert.equal(catalog.control(encodeId("Extraction_Live_Workspace/nope"), { command: "stop" }), null);
  });

  test("round-trips the default window new runs adopt", () => {
    assert.deepEqual(catalog.defaultSchedule(), { mode: "anytime", start: null, end: null });
    catalog.setDefaultSchedule({ mode: "window", start: "22:00", end: "06:00" });
    assert.deepEqual(catalog.defaultSchedule(), { mode: "window", start: "22:00", end: "06:00" });
    assert.ok(fs.existsSync(path.join(root, DEFAULT_SCHEDULE_FILE)));
  });
});
