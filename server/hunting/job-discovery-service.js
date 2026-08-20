import { parseJsonObject } from "./cv-editor-service.js";
import { isFirstPartyFamily, normalizeJob } from "./job-hunt-store.js";
import { abortSessionRun, runSessionTurn } from "./session-turn.js";

const DISCOVERY_AGENT_ID = "main";
const DISCOVERY_MODEL = "openai/gpt-5.6-luna";
const DISCOVERY_SESSION_KEY = `agent:${DISCOVERY_AGENT_ID}:dashboard:hunting-job-discovery`;
// A run browses LinkedIn, Indeed, and first-party sites through a Codex-routed model. A
// live run was still streaming at 288s, so the old 300s ceiling cut off working searches.
const DISCOVERY_TIMEOUT_MS = 900_000;
const MAX_RESULTS_PER_FAMILY = 2;
const MAX_JOBS = 20;
// Sources the brief expects every run to reach. Anything missing has to come back with a
// stated reason rather than silently shrinking the shortlist.
const REQUIRED_SOURCES = ["linkedin", "indeed", "first-party"];

export class JobDiscoveryService {
  constructor({ gateway, timeoutMs = DISCOVERY_TIMEOUT_MS }) {
    this.gateway = gateway;
    this.timeoutMs = timeoutMs;
    this.sessionKey = DISCOVERY_SESSION_KEY;
    this.active = false;
  }

  ownsSession(sessionKey) {
    return sessionKey === this.sessionKey;
  }

  /**
   * One hunt at a time. Queueing a second hunt behind the first is what produced the
   * doomed-retry loop, so a concurrent press is refused instead of silently stacking.
   */
  async discover({ profile, cv, exclusions }) {
    if (this.active) {
      throw Object.assign(new Error("A hunt is already running; wait for it to finish"), {
        statusCode: 409,
      });
    }
    this.active = true;
    try {
      return await this.#runDiscovery({ profile, cv, exclusions });
    } finally {
      this.active = false;
    }
  }

  async #runDiscovery({ profile, cv, exclusions }) {
    const prompt = buildDiscoveryPrompt({ profile, cv, exclusions });

    // A run left over from a previous process would swallow this message.
    await abortSessionRun({
      gateway: this.gateway,
      sessionKey: this.sessionKey,
      agentId: DISCOVERY_AGENT_ID,
    });
    await this.gateway.request("sessions.create", {
      key: this.sessionKey,
      agentId: DISCOVERY_AGENT_ID,
      label: "Hunting · Job Discovery · J.A.R.V.I.S.",
      model: DISCOVERY_MODEL,
    });
    await this.gateway.request("sessions.reset", {
      key: this.sessionKey,
      agentId: DISCOVERY_AGENT_ID,
      reason: "reset",
    });
    await this.gateway.request("sessions.patch", {
      key: this.sessionKey,
      agentId: DISCOVERY_AGENT_ID,
      model: DISCOVERY_MODEL,
      thinkingLevel: "medium",
    });

    const text = await runSessionTurn({
      gateway: this.gateway,
      sessionKey: this.sessionKey,
      agentId: DISCOVERY_AGENT_ID,
      message: prompt,
      timeoutMs: this.timeoutMs,
      label: "Job discovery",
    });
    return parseDiscoveryResponse(text, { knownUrls: exclusions?.knownUrls ?? [] });
  }
}

export function buildDiscoveryPrompt({ profile, cv, exclusions }) {
  return [
    "You are J.A.R.V.I.S., the main orchestrator responsible for job discovery in Hunting.",
    "Search current public job listings on first-party company career sites and reputable boards.",
    "Make separate public-web discovery passes for LinkedIn Jobs, for Indeed, and for first-party company career sites. Use public listing URLs or search-engine results; do not automate a signed-in LinkedIn or Indeed session.",
    "Report a status for every required source in sourceStatus. If LinkedIn, Indeed, or first-party sites returned nothing usable, say so with the concrete reason (blocked, sign-in wall, no qualifying match, search failed).",
    "Build a source-diverse shortlist. Prefer first-party career pages, then a mix of reputable boards; never return more than two listings from one board.",
    "Favor listings posted or materially updated in the past seven days. You may use listings up to fourteen days old only when needed to fill the shortlist, and must exclude older or undated listings when a fresher equivalent exists.",
    "Use browsing or web-search tools when available. Return only jobs that you actually found with a direct HTTP(S) listing URL.",
    "Prefer search paths that do not gate automated access: company career-site search pages, public LinkedIn and Indeed listing URLs, and search engines that answer without a challenge. If a search engine returns an anti-bot challenge, do not retry it and do not try to satisfy it — switch approach, and if the source stays unreachable report it as unavailable with the challenge as the reason.",
    "Do not sign in, submit an application, bypass anti-bot protections, or interact with CAPTCHA. Never read, invoke, or use anti-bot, CAPTCHA, Cloudflare-bypass, or similar bypass tools or skills. A challenge is the user's to clear, not yours: leave the page as it is and say so.",
    "Rank results against the user's search brief and verified CV. Do not infer sensitive facts or eligibility that are not explicit.",
    "The user's queue already holds the listings below. Do not spend the run rediscovering them; find genuinely different roles, and only repeat one of these if it is still the strongest available match.",
    describeExclusions(exclusions),
    "Return only JSON with this shape:",
    '{"jobs":[{"title":"...","company":"...","location":"...","url":"https://...","source":"...","workMode":"remote|hybrid|onsite|unknown","salary":"... or null","listedAt":"YYYY-MM-DD or null","descriptionExcerpt":"short factual excerpt","matchScore":0,"matchReasons":["..."]}],"sourceStatus":[{"source":"linkedin|indeed|first-party|other board name","status":"covered|unavailable","reason":"why it returned nothing, or null"}],"summary":"..."}',
    "Use listedAt only when the listing page itself gives a reliable posted or updated date. Do not guess it.",
    "Return at most 20 strong current matches. An empty jobs array with an honest sourceStatus is better than invented data.",
    `SEARCH BRIEF:\n${JSON.stringify(profile)}`,
    `VERIFIED CV:\n${cv?.content?.slice(0, 80_000) || "No canonical CV is saved; score only against the search brief."}`,
  ].join("\n\n");
}

/** Compact, bounded exclusion payload — a long list would crowd out the brief itself. */
function describeExclusions(exclusions) {
  const knownUrls = (exclusions?.knownUrls ?? []).slice(0, 40);
  const dismissed = (exclusions?.dismissedRoleKeys ?? []).slice(0, 20);
  if (!knownUrls.length && !dismissed.length) return "ALREADY IN QUEUE:\nnothing yet — this is the first run.";
  return [
    "ALREADY IN QUEUE (canonical URLs):",
    knownUrls.join("\n") || "none",
    "PREVIOUSLY DISMISSED (company::title):",
    dismissed.join("\n") || "none",
  ].join("\n");
}

export function parseDiscoveryResponse(text, { knownUrls = [], maxPerFamily = MAX_RESULTS_PER_FAMILY, maxJobs = MAX_JOBS } = {}) {
  const parsed = parseJsonObject(text);
  const known = new Set(knownUrls);
  const byUrl = new Map();
  for (const input of (Array.isArray(parsed?.jobs) ? parsed.jobs : []).slice(0, 30)) {
    try {
      const job = normalizeJob(input);
      const current = byUrl.get(job.canonicalUrl);
      if (!current || job.matchScore > current.matchScore) byUrl.set(job.canonicalUrl, job);
    } catch {
      // A malformed model result must not poison otherwise valid discovery results.
    }
  }

  const familyCounts = new Map();
  const jobs = [];
  let droppedForDiversity = 0;
  for (const job of [...byUrl.values()].sort((a, b) => b.matchScore - a.matchScore)) {
    const alreadyKnown = known.has(job.canonicalUrl);
    // The cap governs new recommendations. A listing the queue already holds is still worth
    // recording, because re-observing it is what keeps its freshness honest.
    if (!alreadyKnown) {
      const count = familyCounts.get(job.sourceFamily) ?? 0;
      if (count >= maxPerFamily) {
        droppedForDiversity += 1;
        continue;
      }
      familyCounts.set(job.sourceFamily, count + 1);
    }
    jobs.push({ ...job, alreadyKnown });
    if (jobs.length >= maxJobs) break;
  }

  return {
    jobs,
    droppedForDiversity,
    sourceStatus: mergeSourceStatus(parsed?.sourceStatus, jobs),
    summary: String(parsed?.summary ?? "Discovery complete").trim().slice(0, 500),
  };
}

/**
 * Coverage is decided by the hostnames actually returned, not by the model's own claim; the
 * model only supplies the reason a source came back empty.
 */
export function mergeSourceStatus(reported, jobs) {
  const claimed = new Map();
  for (const entry of Array.isArray(reported) ? reported : []) {
    const source = String(entry?.source ?? "").trim().toLowerCase();
    if (source) claimed.set(source, entry);
  }
  const counts = new Map();
  for (const job of jobs) {
    const key = isFirstPartyFamily(job.sourceFamily) ? "first-party" : job.sourceFamily;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const statuses = REQUIRED_SOURCES.map((source) => {
    const count = counts.get(source) ?? 0;
    const reason = String(claimed.get(source)?.reason ?? "").trim().slice(0, 300) || null;
    return {
      source,
      status: count > 0 ? "covered" : "unavailable",
      count,
      reason: count > 0 ? null : reason || "the run returned no listing from this source",
    };
  });
  for (const [source, count] of counts) {
    if (REQUIRED_SOURCES.includes(source)) continue;
    statuses.push({ source, status: "covered", count, reason: null });
  }
  return statuses.slice(0, 12);
}
