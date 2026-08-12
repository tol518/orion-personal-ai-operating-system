import assert from "node:assert/strict";
import test from "node:test";
import { deriveLessons, mergePlaybook, playbookKey, playbookTags, playbookTitle, siteHost } from "./site-playbook.js";
import { normalizeManagedUpsert } from "../managed-memory.js";
import { resolveSiteAdapter } from "./site-adapters.js";

const REED = resolveSiteAdapter("https://www.reed.co.uk/jobs/x/1");

test("a playbook is identified by host, so one node serves every job on that site", () => {
  assert.equal(siteHost("https://www.reed.co.uk/jobs/graduate-software-engineer/57145434"), "reed.co.uk");
  assert.equal(siteHost("https://jobs.ashbyhq.com/goodlord/abc"), "jobs.ashbyhq.com");
  assert.equal(playbookKey("reed.co.uk"), "job-application-site-reed-co-uk");
  assert.equal(playbookTitle("reed.co.uk"), "reed.co.uk application playbook");
  assert.equal(siteHost("not a url"), "");
});

test("a sign-in wall is recorded with the fix that makes it a one-time cost", () => {
  const lessons = deriveLessons({
    adapter: REED,
    attempts: [{ phase: "opening_form", outcome: "needs_human_action", reasonCode: "sign_in" }],
    application: { manualActionKind: "sign_in" },
  });
  const wall = lessons.find((l) => l.key === "sign_in_wall");
  assert.equal(wall.section, "fails");
  assert.match(wall.text, /Sign in once by hand in the browser profile; it persists/);
});

test("the failed-then-worked case records both halves", () => {
  // This is the shape worth keeping: not "upload failed", but what fixed it.
  const lessons = deriveLessons({
    adapter: REED,
    attempts: [
      { phase: "uploading_cv", outcome: "uploaded", reasonCode: "verified", evidence: { method: "file-input-read" } },
      {
        phase: "filling_verified_fields",
        outcome: "ready_for_review",
        evidence: {
          attachments: {
            cv: { outcome: "uploaded" },
            coverLetter: {
              outcome: "uploaded",
              format: "pdf",
              attempts: [
                { format: "txt", outcome: "verification_failed" },
                { format: "pdf", outcome: "uploaded" },
              ],
            },
          },
        },
      },
    ],
    application: {},
  });
  const keys = lessons.map((l) => l.key);
  assert.ok(keys.includes("cv_upload:file-input-read"));
  assert.ok(keys.includes("cv_reattach_after_fill"));
  assert.ok(keys.includes("cover_letter_format:pdf"));
  // The rejected format is worth remembering so the next run does not retry it blindly.
  assert.ok(keys.includes("cover_letter_rejected:txt"));
  assert.equal(lessons.find((l) => l.key === "cover_letter_rejected:txt").section, "fails");
});

test("committed dropdown options are kept, typed values are not", () => {
  const lessons = deriveLessons({
    adapter: REED,
    attempts: [],
    application: {
      filledFields: [
        { field: "Where did you hear about us?", source: "application-memory", selectedOption: "Job Board (e.g. LinkedIn, Indeed, CV Library etc.)" },
        { field: "First name", source: "identity-memory" },
      ],
      unresolvedFields: [{ field: "Salary expectation", reason: "no verified figure", required: true }],
    },
  });
  const option = lessons.find((l) => l.key.startsWith("option:"));
  assert.match(option.text, /Job Board/);
  assert.equal(option.section, "answers");
  // A field with no committed option contributes nothing: there is no page structure to learn.
  assert.equal(lessons.some((l) => l.text.includes("First name")), false);
  assert.ok(lessons.some((l) => l.key.startsWith("unresolved:")));
});

test("anything that smells like a credential is refused", () => {
  const lessons = deriveLessons({
    adapter: REED,
    attempts: [],
    application: {
      filledFields: [{ field: "Password", source: "unstated", selectedOption: "hunter2" }],
      unresolvedFields: [{ field: "One-time code", reason: "needs the user", required: true }],
    },
  });
  assert.equal(lessons.length, 0);
});

test("a spam rejection tells the next run to stop automating this host", () => {
  const lessons = deriveLessons({
    adapter: REED,
    attempts: [{ phase: "submitted", outcome: "rejected", reasonCode: "submission_spam_flagged" }],
    application: {},
  });
  assert.match(lessons.find((l) => l.key === "submission_spam_flagged").text, /prepare-only/);
});

test("an aggregator redirect is retained as a reusable tab-ownership lesson", () => {
  const lessons = deriveLessons({
    adapter: REED,
    attempts: [{ phase: "opening_form", outcome: "redirect_followed", reasonCode: "external_application_form" }],
    application: {},
  });
  const redirect = lessons.find((lesson) => lesson.key === "external_application_redirect");
  assert.equal(redirect.section, "works");
  assert.match(redirect.text, /server-owned redirected tab/);
});

test("re-observing a lesson refreshes its date instead of duplicating the line", () => {
  const first = mergePlaybook({
    host: "reed.co.uk",
    existingBody: "",
    lessons: deriveLessons({
      adapter: REED,
      attempts: [{ phase: "opening_form", outcome: "needs_human_action", reasonCode: "sign_in" }],
      application: { manualActionKind: "sign_in" },
    }),
    now: new Date("2026-07-26T10:00:00Z"),
  });
  assert.match(first, /^Trigger: Applying to a job on reed\.co\.uk/);
  assert.match(first, /\nAvoid:\n/);
  assert.match(first, /_\(first seen 2026-07-26\)_/);

  const second = mergePlaybook({
    host: "reed.co.uk",
    existingBody: first,
    lessons: deriveLessons({
      adapter: REED,
      attempts: [{ phase: "opening_form", outcome: "needs_human_action", reasonCode: "sign_in" }],
      application: { manualActionKind: "sign_in" },
    }),
    now: new Date("2026-08-02T10:00:00Z"),
  });
  assert.equal(second.match(/sign in by hand|Sign in once by hand/gi)?.length, 1, "one line, not two");
  assert.match(second, /first seen 2026-07-26, last confirmed 2026-08-02/);
});

test("a lesson whose wording changes updates its own line rather than adding one", () => {
  // Keys ride in an HTML comment, so a reworded observation is still the same observation.
  const before = mergePlaybook({
    host: "reed.co.uk",
    existingBody: "",
    lessons: [{ section: "works", key: "cv_upload:file-input-read", text: "Old wording." }],
    now: new Date("2026-07-26T10:00:00Z"),
  });
  const after = mergePlaybook({
    host: "reed.co.uk",
    existingBody: before,
    lessons: [{ section: "works", key: "cv_upload:file-input-read", text: "New wording." }],
    now: new Date("2026-08-02T10:00:00Z"),
  });
  assert.match(after, /New wording/);
  assert.doesNotMatch(after, /Old wording/);
  // Exactly one line carries this lesson's key; the other bullets are the standing
  // Avoid/Verify guidance every lesson body keeps.
  assert.equal(after.match(/cv_upload:file-input-read/g).length, 1);
  assert.match(after, /first seen 2026-07-26, last confirmed 2026-08-02/);
});

test("the body is a valid Shared Lesson, so it lands in the same procedural memory as the rest", () => {
  // The proven pattern in this app is shared_lesson with Trigger / Better approach / Avoid /
  // Verify, validated by normalizeManagedUpsert. A site playbook has to satisfy the same gate
  // or it never reaches the surface future runs retrieve from.
  const body = mergePlaybook({
    host: "reed.co.uk",
    existingBody: "",
    lessons: [{ section: "works", key: "k", text: "Something observed." }],
    now: new Date("2026-07-26T10:00:00Z"),
  });
  const upsert = normalizeManagedUpsert({
    memoryType: "shared_lesson",
    managedKey: playbookKey("reed.co.uk"),
    title: playbookTitle("reed.co.uk"),
    body,
    tags: playbookTags("reed.co.uk"),
  });
  assert.ok(upsert, "the validator must accept the body");
  assert.equal(upsert.managedKey, "job-application-site-reed-co-uk");
  assert.ok(upsert.tags.includes("shared-lesson"));
  assert.ok(upsert.tags.includes("procedural-memory"));
  assert.ok(upsert.tags.includes("learned-by:main"));
  assert.match(body, /no answer values are recorded here/);
  // Every section stays non-empty, including on a site with nothing recorded yet.
  const empty = mergePlaybook({ host: "new.example", existingBody: "", lessons: [], now: new Date() });
  assert.ok(normalizeManagedUpsert({ memoryType: "shared_lesson", managedKey: playbookKey("new.example"), title: playbookTitle("new.example"), body: empty, tags: [] }));
});

test("an error solved mid-application is recorded as the path that worked", () => {
  // The whole point of the playbook: hitting the same wall twice is the failure, not the wall.
  const lessons = deriveLessons({
    adapter: resolveSiteAdapter("https://job-boards.greenhouse.io/acme/jobs/1"),
    host: "job-boards.greenhouse.io",
    attempts: [
      { phase: "uploading_cv", outcome: "input_not_found", reasonCode: "no_file_input_on_page" },
      { phase: "uploading_cv", outcome: "deferred_to_later_step", reasonCode: "no_file_input_on_page" },
      { phase: "uploading_cv", outcome: "uploaded", reasonCode: "verified", evidence: { method: "file-input-read" } },
    ],
    application: {},
  });
  const byKey = new Map(lessons.map((lesson) => [lesson.key, lesson]));
  // Named for the failure it recovers from, so the same first failure is recognised next time.
  const recovered = byKey.get("recovered:uploading_cv:no_file_input_on_page");
  assert.ok(recovered, [...byKey.keys()].join(", "));
  assert.equal(recovered.section, "works");
  assert.match(recovered.text, /first failed as input_not_found/);
  assert.match(recovered.text, /carry on to the step that worked/);
  // And the specific shape of this form is recorded in its own right.
  assert.match(byKey.get("cv_field_on_later_step").text, /attach the CV when the field appears/);
});

test("a phase that only ever failed records no recovery", () => {
  const lessons = deriveLessons({
    adapter: resolveSiteAdapter("https://example.com/jobs/1"),
    host: "example.com",
    attempts: [
      { phase: "uploading_cv", outcome: "input_not_found", reasonCode: "no_file_input_on_page" },
      { phase: "uploading_cv", outcome: "tool_unavailable", reasonCode: "browser_control_unavailable" },
    ],
    application: {},
  });
  assert.ok(!lessons.some((lesson) => lesson.key.startsWith("recovered:")));
});
