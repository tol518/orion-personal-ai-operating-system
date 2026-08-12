// Generic ProviderB extraction adapter.
//
// ProviderB requires an authorized headed-browser session. The public adapter
// keeps the transport, pagination, normalization, scheduling, and resume logic,
// while the real provider URL and browser profile stay in private configuration.
import fs from "node:fs";
import path from "node:path";
import { BrowserControl, waitForPageReady } from "./hunting/browser-control.js";
import { isWindowOpen, msUntilWindowOpens, __testing as extractionsTesting } from "./extractions.js";

const { normalizeSchedule } = extractionsTesting;
const RUN_FILE = "extraction-run.json";
const CONTROL_FILE = "extraction-control.json";
const DEFAULT_SCHEDULE_FILE = "extraction-schedule.json";
// Matches the workspace runtime the other sites use.
const CONTROL_POLL_MS = 5_000;
const HEARTBEAT_MS = 30_000;

export class StopRequested extends Error {
  constructor() {
    super("Extraction stopped by operator");
    this.name = "StopRequested";
  }
}

const PAGE_SIZE = 25;
// A real browser at a human pace, not a scraper sprint.
const PAGE_DELAY_MS = 1500;
const MAX_PAGES = 200;

// Unified schema, 13 columns. Each platform fills its own rank and leaves the
// others blank. Provider ranks are independent because each adapter may use a
// different result-card model.
export const CSV_HEADERS = [
  "Scrape Date and time",
  "Travel Date",
  "Nights",
  "ProviderA Rank",
  "ProviderC Rank",
  "ProviderB Rank",
  "Hotel Name",
  "Price Per Person",
  "Platform",
  "TO/Provider",
  "What's included",
  "Airline",
  "Destination",
];

const DESTINATIONS_QUERY = `query DestinationLookup($query: String!) {
  destinationSuggestions(query: $query) { id label name }
}`;

// Public neutral contract. A private deployment adapter translates the actual
// provider schema into this shape without exposing provider-specific documents.
const SEARCH_QUERY = `query PackageSearchPage(
  $destinationId:ID!, $departureAirports:[String!]!, $nights:Int!, $adults:Int!,
  $travelDate:Date!, $offset:Int!, $limit:Int!
) {
  packageSearch(input: {
    destinationId: $destinationId,
    departureAirports: $departureAirports,
    nights: $nights,
    adults: $adults,
    travelDate: $travelDate
  }, offset: $offset, limit: $limit) {
    totalCount
    items { kind hotelName nights boardBasisCode pricePerPersonMinor airlineName destinationLabel }
  }
}`;

export function formatScrapeTime(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(now.getDate())}/${p(now.getMonth() + 1)}/${now.getFullYear()} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

export function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

/**
 * One result row -> one CSV row. Kept pure so the mapping is testable without a
 * browser: this is where price units and the promo-card shape actually bite.
 */
export function toCsvRow(item, { travelDate, scrapeTime, destination, nights, rank }) {
  const [y, m, d] = travelDate.split("-");
  return [
    scrapeTime,
    `${d}/${m}/${y}`,
    item.nights ?? nights,
    "",
    "",
    // Position in the site's POPULAR order, continuous across paged requests.
    rank,
    item.hotelName ?? "",
    Math.round((item.pricePerPersonMinor ?? 0) / 100),
    "ProviderB",
    "ProviderB",
    item.boardBasisCode ?? "",
    item.airlineName ?? "Unknown",
    item.destinationLabel ?? destination,
  ];
}

/** `items` is a union; promotional cards carry no hotel and must not become rows. */
export function hotelsOnly(items) {
  return (items ?? []).filter((item) => item.kind === "package" && item.hotelName);
}

// Read at construction, not at module load: index.js calls dotenv.config() in
// its body, which runs *after* this module is imported, so a module-level
// process.env read here is always empty and silently sends no profile at all.
export function defaultBrowserProfile() {
  return process.env.JARVIS_PROVIDER_B_BROWSER_PROFILE || null;
}

export function defaultBaseUrl() {
  return process.env.JARVIS_PROVIDER_B_BASE_URL || "https://provider-b.example/";
}

export function defaultGraphqlPath() {
  return process.env.JARVIS_PROVIDER_B_GRAPHQL_PATH || "/graphql";
}

export class ProviderBExtractor {
  constructor({
    gateway,
    browser = null,
    profile = undefined,
    baseUrl = undefined,
    graphqlPath = undefined,
    workspaceRoot = null,
  }) {
    this.profile = profile === undefined ? defaultBrowserProfile() : profile;
    this.baseUrl = baseUrl === undefined ? defaultBaseUrl() : baseUrl;
    this.graphqlPath = graphqlPath === undefined ? defaultGraphqlPath() : graphqlPath;
    this.browser = browser ?? new BrowserControl({ gateway, profile: this.profile });
    // Needed to find the workspace-wide default run window.
    this.workspaceRoot = workspaceRoot;
  }

  /** Run a GraphQL operation inside the authorized browser session. */
  async #gql(targetId, query, variables, operationName) {
    // The request body is serialised once here and embedded as a single JSON
    // literal, so the query text and variables cross into page context without
    // any quoting of their own to get wrong.
    const endpoint = JSON.stringify(this.graphqlPath);
    const body = JSON.stringify(JSON.stringify({ operationName, query, variables }));
    const fn = `async () => {
      const res = await fetch(${endpoint}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: ${body},
      });
      return { status: res.status, body: await res.json() };
    }`;
    const result = await this.browser.evaluate({ targetId, fn });
    if (!result.ok) throw new Error(`browser evaluate failed: ${result.error}`);
    const payload = result.payload?.result ?? result.payload;
    const value = payload?.value ?? payload;
    if (!value || typeof value !== "object") {
      throw new Error(`unexpected evaluate payload: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    if (value.status !== 200) throw new Error(`graphql HTTP ${value.status}`);
    if (value.body?.errors) {
      throw new Error(`graphql: ${JSON.stringify(value.body.errors[0]).slice(0, 240)}`);
    }
    return value.body.data;
  }

  /** Open the site and prove the session is real before doing any work. */
  async openSession() {
    const opened = await this.browser.openTab(this.baseUrl, "provider-b-extract");
    if (!opened.ok) throw new Error(`openTab failed: ${opened.error}`);
    const targetId =
      opened.payload?.targetId ?? opened.payload?.tab?.targetId ?? opened.payload?.tabs?.[0]?.targetId;
    if (!targetId) throw new Error(`no targetId in openTab response: ${JSON.stringify(opened.payload).slice(0, 200)}`);
    await waitForPageReady(this.browser, { targetId, timeoutMs: 45_000 });
    return targetId;
  }

  /** Cheap end-to-end check of the transport: page loaded, GraphQL answering. */
  async probe() {
    const targetId = await this.openSession();
    try {
      const endpoint = JSON.stringify(this.graphqlPath);
      const fn = `async () => {
        const call = async () => {
          const res = await fetch(${endpoint}, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: "{__typename}" }),
          });
          return res.status;
        };
        const out = { title: document.title, ssr: !!document.getElementById("ssr-data"), webdriver: navigator.webdriver };
        out.immediate = await call();
        await new Promise(r => setTimeout(r, 6000));
        out.after6s = await call();
        return out;
      }`;
      const result = await this.browser.evaluate({ targetId, fn });
      if (!result.ok) throw new Error(`evaluate failed: ${result.error}`);
      const payload = result.payload?.result ?? result.payload;
      return payload?.value ?? payload;
    } finally {
      await this.browser.closeTab(targetId);
    }
  }

  /**
   * ProviderB uses its own numeric ids, unrelated to the codes ProviderA
   * and ProviderD share, so it is resolved live rather than hard-coded — a drifted
   * id would silently extract the wrong city.
   */
  async resolveDestination(targetId, name) {
    const data = await this.#gql(targetId, DESTINATIONS_QUERY, { query: name }, "DestinationLookup");
    const suggestions = data?.destinationSuggestions ?? [];
    const match = suggestions.find((entry) => entry.name === name) ?? suggestions[0];
    if (!match) throw new Error(`no ProviderB destination matches "${name}"`);
    return { id: match.id, label: match.label };
  }

  /**
   * The same run/control contract the workspace scripts use, so a Jarvis-run
   * extraction shows in the Extraction indicator and obeys the run window and
   * pause/stop like every other site. Without this it ran straight through a
   * configured 00:00-08:00 window and reported no progress at all.
   */
  #publish(sessionDir, state, plan, extra = {}) {
    const control = this.#control(sessionDir, plan);
    const now = new Date().toISOString();
    const tmp = path.join(sessionDir, `${RUN_FILE}.tmp`);
    const body = {
      platform: "ProviderB",
      destination: plan.destination,
      nights: plan.nights,
      adults: plan.adults,
      dates: plan.dates,
      startedAt: plan.startedAt,
      // Jarvis is the process doing the work, so its pid is the honest one.
      pid: process.pid,
      state,
      schedule: control.schedule,
      heartbeatAt: now,
      finishedAt: null,
      ...extra,
    };
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    fs.renameSync(tmp, path.join(sessionDir, RUN_FILE));
    plan.lastHeartbeat = Date.now();
    plan.publishedState = state;
  }

  #control(sessionDir, plan) {
    const readJson = (file) => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    };
    const current = readJson(path.join(sessionDir, CONTROL_FILE));
    // A run started unattended adopts the workspace-wide window, exactly as the
    // workspace runtime does for agent-run extractions.
    const fallback = readJson(path.join(this.workspaceRoot ?? "", DEFAULT_SCHEDULE_FILE))?.schedule;
    return {
      command: ["run", "pause", "stop"].includes(current?.command) ? current.command : "run",
      schedule: normalizeSchedule(current?.schedule ?? fallback),
    };
  }

  /** Between pages: honours pause and stop, but not the window. */
  async #checkpoint(sessionDir, plan) {
    for (;;) {
      const { command } = this.#control(sessionDir, plan);
      if (command === "stop") throw new StopRequested();
      if (command !== "pause") {
        if (plan.publishedState !== "running" || Date.now() - plan.lastHeartbeat > HEARTBEAT_MS) {
          this.#publish(sessionDir, "running", plan);
        }
        return;
      }
      if (plan.publishedState !== "paused" || Date.now() - plan.lastHeartbeat > HEARTBEAT_MS) {
        this.#publish(sessionDir, "paused", plan);
      }
      await new Promise((r) => setTimeout(r, CONTROL_POLL_MS));
    }
  }

  /** Between dates: also waits out a closed run window. */
  async #beforeDate(sessionDir, plan) {
    for (;;) {
      await this.#checkpoint(sessionDir, plan);
      const { schedule } = this.#control(sessionDir, plan);
      if (isWindowOpen(schedule)) return;
      const waitMs = msUntilWindowOpens(schedule);
      if (plan.publishedState !== "waiting" || Date.now() - plan.lastHeartbeat > HEARTBEAT_MS) {
        this.#publish(sessionDir, "waiting", plan, {
          windowOpensAt: new Date(Date.now() + waitMs).toISOString(),
        });
      }
      // Poll rather than sleeping the gap: the operator may widen the window,
      // switch to anytime, or stop while we hold.
      await new Promise((r) => setTimeout(r, Math.min(waitMs, CONTROL_POLL_MS)));
    }
  }

  async #extractDate(targetId, { destinationId, destination, travelDate, nights, adults, airports, sessionDir, plan }) {
    const variables = {
      destinationId: String(destinationId),
      departureAirports: airports,
      nights,
      adults,
      travelDate,
      offset: 0,
      limit: PAGE_SIZE,
    };

    const dateDir = path.join(sessionDir, ".scraped", travelDate);
    fs.mkdirSync(dateDir, { recursive: true });

    const hotels = [];
    let total = null;
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const start = pageIndex * PAGE_SIZE;
      if (total !== null && start >= total) break;
      await this.#checkpoint(sessionDir, plan);
      const data = await this.#gql(
        targetId,
        SEARCH_QUERY,
        { ...variables, offset: start },
        "PackageSearchPage",
      );
      const sr = data.packageSearch;
      fs.writeFileSync(path.join(dateDir, `page-${start}.json`), JSON.stringify(sr));
      if (total === null) total = sr.totalCount;
      const page = hotelsOnly(sr.items);
      if (page.length === 0) break;
      hotels.push(...page);
      await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
    }

    const scrapeTime = formatScrapeTime();
    const rows = hotels.map((item, index) =>
      toCsvRow(item, { travelDate, scrapeTime, destination, nights, rank: index + 1 }),
    );
    const csv = [CSV_HEADERS.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";
    fs.writeFileSync(path.join(sessionDir, `results-${travelDate}.csv`), csv);
    return { travelDate, total, rows: rows.length };
  }

  /**
   * Extract every date into `sessionDir`, resuming over dates that already have
   * a CSV so an interrupted run picks up where it stopped.
   */
  async extract({
    destination,
    dates,
    nights = 7,
    adults = 2,
    airports = ["LON"],
    sessionDir,
    onProgress = () => {},
  }) {
    fs.mkdirSync(sessionDir, { recursive: true });
    const plan = {
      destination,
      dates,
      nights,
      adults,
      startedAt: new Date().toISOString(),
      lastHeartbeat: 0,
      publishedState: null,
    };
    // Published before the browser opens, so the run is visible from the moment
    // it exists rather than only once the first date lands.
    this.#publish(sessionDir, "running", plan);

    const targetId = await this.openSession();
    const results = [];
    let stopped = false;
    try {
      const resolved = await this.resolveDestination(targetId, destination);
      onProgress({ stage: "destination", ...resolved });

      for (const travelDate of dates) {
        if (fs.existsSync(path.join(sessionDir, `results-${travelDate}.csv`))) {
          onProgress({ stage: "skip", travelDate });
          continue;
        }
        try {
          // Holds here while paused or outside the run window; the next window
          // resumes on this same date, since its CSV was never written.
          await this.#beforeDate(sessionDir, plan);
        } catch (err) {
          if (err instanceof StopRequested) {
            stopped = true;
            break;
          }
          throw err;
        }
        const outcome = await this.#extractDate(targetId, {
          destinationId: resolved.id,
          destination,
          travelDate,
          nights,
          adults,
          airports,
          sessionDir,
          plan,
        });
        results.push(outcome);
        onProgress({ stage: "date", ...outcome });
      }
    } catch (err) {
      if (err instanceof StopRequested) stopped = true;
      else {
        this.#publish(sessionDir, "stopped", plan, { finishedAt: new Date().toISOString() });
        throw err;
      }
    } finally {
      await this.browser.closeTab(targetId);
    }

    const files = fs
      .readdirSync(sessionDir)
      .filter((f) => /^results-\d{4}-\d{2}-\d{2}\.csv$/.test(f))
      .sort();
    if (files.length > 0) {
      const combined = [fs.readFileSync(path.join(sessionDir, files[0]), "utf8").split("\n")[0]];
      for (const file of files) {
        combined.push(...fs.readFileSync(path.join(sessionDir, file), "utf8").trim().split("\n").slice(1));
      }
      fs.writeFileSync(path.join(sessionDir, "provider-b-combined.csv"), combined.join("\n") + "\n");
    }
    // Completion is terminal and beats the window, as for every other site.
    this.#publish(sessionDir, stopped ? "stopped" : "complete", plan, {
      finishedAt: new Date().toISOString(),
    });
    return results;
  }
}
