// Per-site knowledge for controlled applications, keyed by host.
//
// Everything here is a hint, never a contract: selectors are tried in order and only
// believed when the upload postcondition proves the file is attached, and control labels
// exist so the runner prompt can name what it may click and what stays human-only.
// Keeping the strings here means no site-specific text leaks into prompts or BFF flow.

const GENERIC_FILE_INPUT_SELECTORS = [
  'input[type="file"][accept*="pdf"]',
  'input[type="file"][name*="resume" i]',
  'input[type="file"][name*="cv" i]',
  'input[type="file"]',
];

const GENERIC_CAPTCHA_TEXT = [
  "i'm not a robot",
  "recaptcha",
  "hcaptcha",
  "verify you are human",
  "verify you're human",
  "press and hold",
  "checking if the site connection is secure",
  "unusual traffic",
];

// Submission failures are not challenges to work around. Detect them after the user submits
// so the application ledger cannot say "submitted" when the employer actually rejected it.
const SUBMISSION_REJECTION_MARKERS = [
  {
    reasonCode: "submission_spam_flagged",
    marker: "application submission was flagged as possible spam",
    detail: "The employer rejected the submission as possible spam.",
  },
  {
    reasonCode: "submission_rejected",
    marker: "we couldn't submit your application",
    detail: "The employer page reports that the application was not submitted.",
  },
];

const ADAPTERS = [
  {
    id: "linkedin",
    label: "LinkedIn",
    hosts: ["linkedin.com"],
    // Easy Apply renders a modal whose resume input is hidden behind a styled button, so
    // the hidden input is the reliable target rather than the visible control.
    fileInputSelectors: [
      'input[type="file"][id*="jobs-document-upload"]',
      'input[type="file"][name="file"]',
      ...GENERIC_FILE_INPUT_SELECTORS,
    ],
    loginUrlMarkers: ["/login", "/uas/login", "/authwall", "/checkpoint/lg"],
    // Apply-specific phrasing only: "sign in to see who was hired" and similar copy appears
    // on perfectly usable public listings and would otherwise stop every run.
    loginTextMarkers: ["join linkedin to apply", "sign in to apply", "agree & join linkedin"],
    captchaUrlMarkers: ["/checkpoint/challenge"],
    captchaTextMarkers: ["security verification", "quick security check", ...GENERIC_CAPTCHA_TEXT],
    applyEntryLabels: ["easy apply", "apply"],
    progressControlLabels: ["next", "continue", "review", "choose existing resume"],
    forbiddenControlLabels: ["submit application", "submit", "send application"],
    // LinkedIn removes the file input from the final review step. These three controls together
    // prove that Easy Apply has a reviewable resume document and is ready to submit; a listing
    // page or an earlier application step does not expose this combination.
    resumeReviewEvidence: {
      documentControls: ["edit resume", "view document"],
      submitControls: ["submit application"],
    },
    notes:
      "Easy Apply is a multi-step modal. Progressing through Next/Review is allowed; deterministic server code owns the final Submit application action. External 'Apply' links leave LinkedIn for the employer form.",
  },
  {
    id: "indeed",
    label: "Indeed",
    hosts: ["indeed.com", "indeed.co.uk"],
    fileInputSelectors: [
      'input[type="file"][data-testid*="resume" i]',
      'input[type="file"][id*="resume" i]',
      ...GENERIC_FILE_INPUT_SELECTORS,
    ],
    loginUrlMarkers: ["/account/login", "secure.indeed.com", "/auth"],
    loginTextMarkers: ["sign in to your indeed account", "create an indeed account", "sign in to apply"],
    captchaUrlMarkers: ["/challenge", "/blocked"],
    captchaTextMarkers: ["additional verification required", ...GENERIC_CAPTCHA_TEXT],
    applyEntryLabels: ["apply now", "apply on company site", "continue"],
    progressControlLabels: ["continue", "next", "review your application"],
    forbiddenControlLabels: ["submit your application", "submit application", "submit"],
    notes:
      "Indeed Smart Apply runs as a multi-page flow and can host the employer form in an iframe; an iframe form is a human checkpoint because page-level automation cannot reach it.",
  },
  {
    id: "ashby",
    label: "Ashby",
    hosts: ["ashbyhq.com", "jobs.ashbyhq.com"],
    fileInputSelectors: [
      'input[type="file"][id*="resume" i]',
      'input[type="file"][accept*="pdf"]',
      ...GENERIC_FILE_INPUT_SELECTORS,
    ],
    loginUrlMarkers: [],
    loginTextMarkers: [],
    captchaUrlMarkers: [],
    captchaTextMarkers: GENERIC_CAPTCHA_TEXT,
    applyEntryLabels: ["apply for this job", "apply"],
    progressControlLabels: ["autofill with resume", "upload file"],
    forbiddenControlLabels: ["submit application", "submit"],
    notes:
      "The Resume field shows an Upload File button in front of a hidden file input; bind the hidden input rather than clicking the button. Ashby Yes/No questions can render as two plain buttons backed by a hidden checkbox. Click the exact visible answer, then take a fresh snapshot and confirm that option visibly remains selected; if both buttons still look unselected, retry the field once and report it unresolved if it still does not persist.",
  },
  {
    id: "greenhouse",
    label: "Greenhouse",
    hosts: ["greenhouse.io"],
    fileInputSelectors: GENERIC_FILE_INPUT_SELECTORS,
    loginUrlMarkers: [],
    loginTextMarkers: [],
    captchaUrlMarkers: [],
    captchaTextMarkers: GENERIC_CAPTCHA_TEXT,
    applyEntryLabels: ["apply for this job", "apply"],
    progressControlLabels: ["continue", "next"],
    forbiddenControlLabels: ["submit application", "submit your application", "submit"],
    notes:
      "Greenhouse can render its application controls behind a component boundary. The server falls back to a fresh accessibility snapshot for the final submit control and clicks it once only after the form checks pass.",
  },
];

const GENERIC_ADAPTER = {
  id: "generic",
  label: "Employer form",
  hosts: [],
  fileInputSelectors: GENERIC_FILE_INPUT_SELECTORS,
  loginUrlMarkers: ["/login", "/signin", "/sign-in", "/auth"],
  loginTextMarkers: ["sign in to continue", "create an account to apply", "log in to apply"],
  captchaUrlMarkers: [],
  captchaTextMarkers: GENERIC_CAPTCHA_TEXT,
  applyEntryLabels: ["apply", "apply now", "apply for this job"],
  progressControlLabels: ["next", "continue"],
  forbiddenControlLabels: ["submit", "submit application", "send application"],
  notes: "Unknown host: rely on the generic file input and stop at anything ambiguous.",
};

/**
 * How much of the form J.A.R.V.I.S. may complete on a given host.
 *
 * `assisted` is the normal path: fill the fields verified data supports and stop before submit.
 * `prepare_only` exists for employers whose anti-spam checks reject automated submissions —
 * an Ashby form answered "Your application submission was flagged as possible spam". The
 * answer to that is not to disguise the automation, which is exactly the evasion this project
 * refuses; it is to do the preparation work and let the user complete the form themselves.
 */
export const AUTOMATION_POLICIES = new Set(["assisted", "prepare_only"]);

/**
 * Hosts default to `assisted`. Set `JARVIS_PREPARE_ONLY_HOSTS` (comma-separated hostnames) to
 * downgrade an employer that flags automation, without a code change.
 */
export function resolveAutomationPolicy(url, { prepareOnlyHosts = readPrepareOnlyHosts() } = {}) {
  let hostname = "";
  try {
    hostname = new URL(String(url ?? "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "assisted";
  }
  const matched = prepareOnlyHosts.some(
    (host) => host && (hostname === host || hostname.endsWith(`.${host}`)),
  );
  return matched ? "prepare_only" : "assisted";
}

function readPrepareOnlyHosts() {
  return String(process.env.JARVIS_PREPARE_ONLY_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
}

/** Resolve the adapter that owns a URL's host, falling back to the generic form profile. */
export function resolveSiteAdapter(url) {
  let hostname = "";
  try {
    hostname = new URL(String(url ?? "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return GENERIC_ADAPTER;
  }
  return (
    ADAPTERS.find((adapter) =>
      adapter.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)),
    ) ?? GENERIC_ADAPTER
  );
}

/**
 * Cheap pre-upload gate: a sign-in wall or anti-bot challenge must stop the run before
 * any field or upload work, and the kind decides which manual action the UI shows.
 * URL markers are trusted; text markers need the page body because links to a login page
 * appear on plenty of ordinary listings.
 */
export function detectHumanCheckpoint({ url, text = "", adapter = GENERIC_ADAPTER }) {
  const haystackUrl = String(url ?? "").toLowerCase();
  const haystackText = String(text ?? "").toLowerCase();
  const captchaUrl = adapter.captchaUrlMarkers.find((marker) => haystackUrl.includes(marker));
  if (captchaUrl) {
    return { kind: "captcha", detail: `${adapter.label} anti-bot challenge at ${captchaUrl}` };
  }
  const captchaText = adapter.captchaTextMarkers.find((marker) => haystackText.includes(marker));
  if (captchaText) {
    return { kind: "captcha", detail: `${adapter.label} page shows an anti-bot challenge ("${captchaText}")` };
  }
  const loginUrl = adapter.loginUrlMarkers.find((marker) => haystackUrl.includes(marker));
  if (loginUrl) {
    return { kind: "sign_in", detail: `${adapter.label} redirected to a sign-in page (${loginUrl})` };
  }
  const loginText = adapter.loginTextMarkers.find((marker) => haystackText.includes(marker));
  if (loginText) {
    return { kind: "sign_in", detail: `${adapter.label} is asking for sign-in ("${loginText}")` };
  }
  return null;
}

/** A rejected submission stays human-owned; callers must never turn this into an auto-retry. */
export function detectSubmissionRejection({ text = "" }) {
  const haystack = String(text ?? "").toLowerCase();
  const match = SUBMISSION_REJECTION_MARKERS.find(({ marker }) => haystack.includes(marker));
  return match
    ? { reasonCode: match.reasonCode, detail: match.detail, evidence: match.marker }
    : null;
}

/** Prompt-facing summary of what the site allows, so policy lives here and not in prompts. */
export function describeAdapterForPrompt(adapter) {
  return [
    `SITE: ${adapter.label} (${adapter.id})`,
    `Notes: ${adapter.notes}`,
    `Controls you may click to progress: ${adapter.progressControlLabels.join(", ") || "none listed"}`,
    `Controls you must never click: ${adapter.forbiddenControlLabels.join(", ")}`,
  ].join("\n");
}
