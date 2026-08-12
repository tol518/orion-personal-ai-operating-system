// Fires extraction tasks on their chosen weekdays by handing the work to the
// agent the user picked.
//
// Jarvis does not scrape. It owns the schedule and the instruction; the agent
// owns execution, exactly as it does when a person asks it in chat. What comes
// back is a normal extraction session in the workspace, so the run indicator,
// the hour window, and pause/stop all apply to it unchanged.
import fs from "node:fs";
import path from "node:path";
import { abortSessionRun, runSessionTurn } from "./hunting/session-turn.js";
import { BFF_EXTRACTED_SITES, formatNights, travelDates } from "./extraction-tasks.js";

const TICK_MS = 60_000;
// A month of departures across two sites is a long turn; the cap exists so a
// wedged run cannot hold the session forever, not to bound normal work.
const DISPATCH_TIMEOUT_MS = 90 * 60 * 1000;

/** Sites the agent handles, versus the ones the BFF extracts itself. */
export function splitSites(sites) {
  return {
    agentSites: sites.filter((site) => !BFF_EXTRACTED_SITES.includes(site)),
    bffSites: sites.filter((site) => BFF_EXTRACTED_SITES.includes(site)),
  };
}

const WEEKDAY_LABELS = {
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

export function buildTaskPrompt(task, today = localDayKey(new Date())) {
  const dates = travelDates(task);
  const nights = formatNights(task.nights);
  // Departures may be restricted to the weekdays flights actually operate on;
  // say which, so the agent does not search dates that were deliberately cut.
  const departureRule =
    task.departureDays?.length > 0
      ? `${task.departureDays.map((d) => WEEKDAY_LABELS[d]).join("/")} departures only`
      : "every date in range";
  const { agentSites, bffSites } = splitSites(task.sites);
  const sites = agentSites.join(" and ");
  // Only the agent's own sites are named as work; a site Jarvis extracts itself
  // is mentioned as context so the agent does not go looking for it, and does
  // not try to drive a browser it cannot reach.
  const alreadyHandled =
    bffSites.length > 0
      ? `\nJarvis extracts ${bffSites.join(" and ")} itself; do not attempt ${bffSites.length === 1 ? "it" : "them"}.`
      : "";
  const comparison =
    task.sites.length > 1
      ? `\nAfter both sites are extracted, produce the comparison CSV per the Comparison Protocols, matching hotels with the Name Match Protocols.`
      : "";

  // Named explicitly rather than left to the agent's judgement: a scheduled run
  // has nobody watching it, so the parameters must not drift between firings.
  return [
    `Scheduled extraction task ${task.id} (Jarvis Extraction).`,
    "",
    `Destination: ${task.destination}`,
    `Sites: ${sites}${alreadyHandled}`,
    `Travel dates: ${task.travelStart} to ${task.travelEnd} (${dates.length} departure ${
      dates.length === 1 ? "date" : "dates"
    }, ${departureRule})`,
    `Nights: ${nights}`,
    "",
    "Follow the extraction protocols in protocols/ for each site.",
    "Use lib/extraction-runtime.js for the run controller so this run reports progress",
    "and obeys the run window and pause/stop from the Jarvis Extraction panel:",
    "call run.start(), await run.beforeDate() per date, await run.checkpoint() between pages,",
    "and run.finish() at the end.",
    // Absolute, because a bare "Extraction_Live_Workspace/..." was resolved
    // against $HOME and the output landed outside the shared workspace, where
    // nothing could see it.
    `Write one session folder per site under ~/.openclaw/workspace/Extraction_Live_Workspace/${today}/`,
    `with one results-<date>.csv per departure date (${dates.length} of them) and a combined CSV at the end.`,
    comparison,
    "",
    "Reply with one line per site: the absolute session folder path, the number of",
    "results-<date>.csv files written, and the total row count.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export class ExtractionScheduler {
  /**
   * `dispatch` is the seam: by default one agent turn on the task's own session,
   * swapped in tests so schedule behaviour can be checked without a gateway.
   */
  constructor({
    store,
    gateway,
    providerB = null,
    workspaceRoot = null,
    tickMs = TICK_MS,
    timeoutMs = DISPATCH_TIMEOUT_MS,
    now = () => new Date(),
    dispatch,
  }) {
    this.store = store;
    this.gateway = gateway;
    this.providerB = providerB;
    this.workspaceRoot = workspaceRoot;
    this.tickMs = tickMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.dispatch = dispatch ?? ((task) => this.#runTask(task));
    this.inFlight = new Set();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        // A failed tick is recorded per task; the loop itself must survive.
      });
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sessionKey(task) {
    return `agent:${task.agentId}:dashboard:extraction-task-${task.id}`;
  }

  async tick() {
    const now = this.now();
    this.store.expire(now);
    const dispatched = [];
    for (const task of this.store.due(now)) {
      if (this.inFlight.has(task.id)) continue;
      // Claim the day before dispatching: if this throws, crashes, or the
      // process restarts mid-turn, the task still cannot fire twice today.
      const claimed = this.store.claimRun(task.id, localDayKey(now));
      if (!claimed) continue;
      dispatched.push(claimed);
      this.#dispatch(claimed);
    }
    return dispatched;
  }

  /**
   * Did the agent's work actually land in the shared workspace? Returns a note
   * per site that produced nothing, so a silent failure shows on the task card
   * instead of being hidden behind a confident reply.
   */
  #verifyAgentOutput(sites, today) {
    if (!this.workspaceRoot) return [];
    const dayDir = path.join(this.workspaceRoot, "Extraction_Live_Workspace", today);
    let sessions = [];
    try {
      sessions = fs
        .readdirSync(dayDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // No day folder at all means nothing was written today.
    }
    return sites.flatMap((site) => {
      const token = site.toLowerCase().replace(/[^a-z]/g, "");
      const match = sessions.find((name) => name.toLowerCase().replace(/[^a-z]/g, "").includes(token));
      if (!match) return [`⚠️ ${site}: no session folder in ${today} — reported output did not reach the workspace`];
      const csvs = fs
        .readdirSync(path.join(dayDir, match))
        .filter((f) => /^results-\d{4}-\d{2}-\d{2}\.csv$/.test(f)).length;
      return csvs === 0 ? [`⚠️ ${site}: ${match} has no results CSVs`] : [`${site}: ${match} — ${csvs} date CSVs on disk`];
    });
  }

  /** Test seam for the private verifier above. */
  verifyAgentOutputForTest(sites, today) {
    return this.#verifyAgentOutput(sites, today);
  }

  /**
   * Stop work already handed to the agent. Cancelling or deleting a task has to
   * reach the turn it dispatched, or the agent carries on extracting for a task
   * that no longer exists.
   */
  async abort(task) {
    if (!task) return false;
    this.inFlight.delete(task.id);
    try {
      await abortSessionRun({
        gateway: this.gateway,
        sessionKey: this.sessionKey(task),
        agentId: task.agentId,
      });
      return true;
    } catch {
      // Nothing in flight, or the gateway is unreachable; the task is stopped
      // either way and the caller should not fail because of it.
      return false;
    }
  }

  /** Run one task now, outside its schedule, without consuming the day's slot. */
  async runNow(taskId) {
    const task = this.store.get(taskId);
    if (!task) return null;
    if (task.status !== "active") {
      throw Object.assign(new Error("Only active tasks can run"), { statusCode: 409 });
    }
    if (this.inFlight.has(task.id)) {
      throw Object.assign(new Error("This task is already running"), { statusCode: 409 });
    }
    this.#dispatch(task);
    return this.store.get(taskId);
  }

  /**
   * A task can span both worlds: the agent extracts its sites, and Jarvis
   * extracts the ones only it can reach. Both run, and the reply records each.
   */
  async #runTask(task) {
    const { agentSites, bffSites } = splitSites(task.sites);
    const notes = [];

    if (bffSites.includes("ProviderB")) {
      if (!this.providerB || !this.workspaceRoot) {
        notes.push("ProviderB: skipped (extractor not configured)");
      } else {
        try {
          // Local day, matching the scheduler's own day arithmetic. Using UTC
          // here put a run that fired just after local midnight into the
          // previous day's folder, where it resumed instead of taking a new
          // snapshot. The HHMM suffix keeps each run its own snapshot, which is
          // the point of a repeating task — resume still works within a run,
          // because a retry of the same run reuses the same folder name.
          const stamp = this.now();
          const sessionDir = path.join(
            this.workspaceRoot,
            "Extraction_Live_Workspace",
            localDayKey(stamp),
            `provider-b-${String(task.destination).toLowerCase()}-${task.travelStart}-to-${task.travelEnd}_${hhmm(stamp)}`,
          );
          const results = await this.providerB.extract({
            destination: task.destination,
            dates: travelDates(task),
            // One search per stay length; a range would need one pass each, so
            // the shortest is used and the reply says so rather than pretending
            // the whole range was covered.
            nights: task.nights.min,
            sessionDir,
          });
          if (task.nights.max !== task.nights.min) {
            notes.push(`ProviderB: only ${task.nights.min} nights covered (range not yet supported)`);
          }
          const rows = results.reduce((sum, r) => sum + r.rows, 0);
          notes.push(`ProviderB: ${path.basename(sessionDir)} — ${rows} rows`);
        } catch (err) {
          notes.push(`ProviderB: failed — ${String(err?.message ?? err)}`);
        }
      }
    }

    if (agentSites.length > 0) {
      const today = localDayKey(this.now());
      const reply = await runSessionTurn({
        gateway: this.gateway,
        sessionKey: this.sessionKey(task),
        agentId: task.agentId,
        message: buildTaskPrompt(task, today),
        timeoutMs: this.timeoutMs,
        label: `extraction-task-${task.id}`,
      });
      notes.push(String(reply ?? "").trim());
      // Trust but verify: an agent has reported a session folder and a row
      // count for work that never reached the workspace at all. Only what is
      // on disk counts.
      notes.push(...this.#verifyAgentOutput(agentSites, today));
    }

    return notes.filter(Boolean).join("\n");
  }

  #dispatch(task) {
    this.inFlight.add(task.id);
    // Recorded before the turn starts so the card can say "working" from the
    // first moment, and so a dispatch is never invisible.
    this.store.startRun(task.id);
    // Not awaited: an extraction is minutes to hours of agent work, and the
    // scheduler must stay responsive to the next tick.
    Promise.resolve()
      .then(() => this.dispatch(task))
      .then((reply) => this.store.finishRun(task.id, reply))
      .catch((err) => this.store.finishRun(task.id, `failed: ${String(err?.message ?? err)}`))
      .finally(() => this.inFlight.delete(task.id));
  }
}

function localDayKey(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Session-folder time suffix, matching the `_HHMM` convention the agent uses. */
function hhmm(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}${pad(date.getMinutes())}`;
}
