import assert from "node:assert/strict";
import test from "node:test";
import {
  assessFormCompletion,
  collapseChoiceGroups,
  labelsMatch,
  normalizeLabel,
  optionMatchesPageValue,
  readFormState,
} from "./form-state.js";
import { matchOption } from "./field-policy.js";

test("a combobox typed into but never committed is not accepted as answered", () => {
  // The exact failure this exists for: the visa question looked answered to the model and was
  // empty on the page, because a searchable dropdown discards uncommitted text.
  const assessment = assessFormCompletion({
    fields: [
      { index: 0, tag: "input", type: "text", label: "Name", required: true, value: "Example User" },
      {
        index: 1,
        tag: "input",
        type: "text",
        label: "Do you have the right to work in the UK without restriction?",
        required: true,
        value: "",
      },
    ],
    claimedFields: [
      { field: "Name", source: "identity-memory" },
      { field: "Do you have the right to work in the UK without restriction?", source: "application-memory" },
    ],
  });
  assert.deepEqual(assessment.verifiedFields.map((f) => f.field), ["Name"]);
  assert.equal(assessment.unverifiedClaims.length, 1);
  assert.match(assessment.unverifiedClaims[0].reason, /no value/);
  assert.equal(assessment.complete, false);
});

test("an empty optional field is skipped while an empty required field blocks", () => {
  const assessment = assessFormCompletion({
    fields: [
      { index: 0, tag: "input", type: "text", label: "Email", required: true, value: "t@example.com" },
      { index: 1, tag: "textarea", type: "textarea", label: "Cover note", required: false, value: "" },
      { index: 2, tag: "input", type: "text", label: "Phone Number", required: true, value: "" },
    ],
    claimedFields: [{ field: "Email", source: "identity-memory" }],
  });
  assert.deepEqual(assessment.blockingFields.map((f) => f.field), ["Phone Number"]);
  assert.deepEqual(assessment.skippedOptional.map((f) => f.field), ["Cover note"]);
  assert.equal(assessment.blockingFields[0].required, true);
  assert.equal(assessment.skippedOptional[0].required, false);
  assert.equal(assessment.complete, false);
});

test("a form whose required fields are all answered is complete despite blank optionals", () => {
  const assessment = assessFormCompletion({
    fields: [
      { index: 0, tag: "input", type: "text", label: "Name *", required: true, value: "the user" },
      { index: 1, tag: "textarea", type: "textarea", label: "Optional additional note", required: false, value: "" },
    ],
    claimedFields: [{ field: "Name", source: "identity-memory" }],
  });
  assert.equal(assessment.complete, true);
  assert.equal(assessment.blockingFields.length, 0);
  assert.equal(assessment.skippedOptional.length, 1);
});

test("a model-declared skip cannot suppress a required field", () => {
  const assessment = assessFormCompletion({
    fields: [{ index: 0, tag: "select", type: "select", label: "Where did you hear about us?", required: true, value: "" }],
    claimedFields: [],
    skipLabels: ["Where did you hear about us?"],
  });
  assert.equal(assessment.blockingFields.length, 1);
  assert.equal(assessment.complete, false);
});

test("an unattached required file blocks review, an optional one is skipped", () => {
  // Assessment runs after the upload service and the attachment repair have both had their
  // turn, so an empty required file field here is a real blocker rather than a pending step.
  const assessment = assessFormCompletion({
    fields: [
      { index: 0, tag: "input", type: "file", label: "CV", required: true, value: "" },
      { index: 1, tag: "input", type: "file", label: "Cover note", required: false, value: "" },
      { index: 2, tag: "input", type: "file", label: "Portfolio", required: true, value: "portfolio.pdf" },
    ],
    claimedFields: [],
  });
  assert.deepEqual(assessment.blockingFields.map((f) => f.field), ["CV"]);
  assert.match(assessment.blockingFields[0].reason, /required file is not attached/);
  assert.deepEqual(assessment.skippedOptional.map((f) => f.field), ["Cover note"]);
  assert.equal(assessment.complete, false);
});

test("a cover letter file the repair pass gave up on does not block when the page marks it optional", () => {
  const assessment = assessFormCompletion({
    fields: [{ index: 0, tag: "input", type: "file", label: "Cover letter", required: false, value: "" }],
    claimedFields: [],
    // The repair pass reports what it passed over; that decision is respected here.
    skipLabels: ["Cover letter"],
  });
  assert.equal(assessment.blockingFields.length, 0);
  assert.equal(assessment.complete, true);
});

test("an answered radio group is one answered question, not five empty ones", () => {
  // Read per button, the unselected siblings looked like empty required fields, and an
  // application that had already answered this was sent back asking for it again.
  const radios = [
    { index: 0, tag: "input", type: "radio", name: "source", label: "Job Board (e.g. LinkedIn, Indeed, CV Library etc.)", groupLabel: "Where did you hear about us?", required: true, checked: true, value: "checked" },
    { index: 1, tag: "input", type: "radio", name: "source", label: "Word of mouth", groupLabel: "Where did you hear about us?", required: true, checked: false, value: "" },
    { index: 2, tag: "input", type: "radio", name: "source", label: "Advertising", groupLabel: "Where did you hear about us?", required: false, checked: false, value: "" },
  ];
  const collapsed = collapseChoiceGroups(radios);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].label, "Where did you hear about us?");
  assert.equal(collapsed[0].value, "Job Board (e.g. LinkedIn, Indeed, CV Library etc.)");
  assert.equal(collapsed[0].required, true);
  assert.equal(collapsed[0].optionCount, 3);

  const assessment = assessFormCompletion({
    fields: collapsed,
    claimedFields: [
      {
        field: "Where did you hear about us?",
        source: "application-memory",
        selectedOption: "Job Board (e.g. LinkedIn, Indeed, CV Library etc.)",
        sourceFact: "Job Board",
      },
    ],
  });
  assert.equal(assessment.blockingFields.length, 0);
  assert.equal(assessment.unverifiedClaims.length, 0);
  assert.equal(assessment.complete, true);
});

test("an unanswered required radio group still blocks", () => {
  const collapsed = collapseChoiceGroups([
    { index: 0, tag: "input", type: "radio", name: "source", label: "Job Board", groupLabel: "Where did you hear about us?", required: true, checked: false, value: "" },
    { index: 1, tag: "input", type: "radio", name: "source", label: "Advertising", groupLabel: "Where did you hear about us?", required: true, checked: false, value: "" },
  ]);
  const assessment = assessFormCompletion({ fields: collapsed, claimedFields: [] });
  assert.deepEqual(assessment.blockingFields.map((f) => f.field), ["Where did you hear about us?"]);
});

test("ARIA radio controls are collapsed and verified like native radio inputs", async () => {
  const state = await readFormState({
    targetId: "ashby-tab",
    browser: {
      evaluate: async ({ fn }) => {
        assert.match(fn, /\[role="radio"\]/);
        assert.match(fn, /isStateControl/);
        assert.match(fn, /customBinaryFields/);
        assert.doesNotMatch(fn, /hasUniqueMarker/);
        assert.match(fn, /stateClass/);
        assert.match(fn, /backingNames/);
        return {
          ok: true,
          payload: {
            result: [
              {
                index: 0,
                tag: "button",
                type: "radio",
                name: null,
                label: "Yes",
                groupLabel: "Are you happy to come to the office 3 times a week?",
                required: true,
                checked: true,
                value: "Yes",
              },
              {
                index: 1,
                tag: "button",
                type: "radio",
                name: null,
                label: "No",
                groupLabel: "Are you happy to come to the office 3 times a week?",
                required: true,
                checked: false,
                value: "",
              },
            ],
          },
        };
      },
    },
  });
  assert.equal(state.available, true);
  assert.equal(state.fields.length, 1);
  assert.equal(state.fields[0].value, "Yes");
  const assessment = assessFormCompletion({
    fields: state.fields,
    claimedFields: [
      {
        field: "Are you happy to come to the office 3 times a week?",
        source: "application-memory",
        selectedOption: "Yes",
        sourceFact: "Happy to come to the office three times a week",
      },
    ],
  });
  assert.equal(assessment.unverifiedClaims.length, 0);
  assert.equal(assessment.complete, true);
});

test("an empty live field inventory fails closed", async () => {
  const state = await readFormState({
    targetId: "unexpected-page",
    browser: {
      evaluate: async () => ({ ok: true, payload: { result: [] } }),
    },
  });
  assert.equal(state.available, false);
  assert.match(state.error, /no application fields/);
});

test("a retained No value in a custom binary group verifies the model claim", () => {
  const assessment = assessFormCompletion({
    fields: [
      {
        index: 0,
        tag: "binary-group",
        type: "selection",
        label: "Would you now or in the future require a visa for employment?",
        required: true,
        checked: true,
        value: "No",
      },
    ],
    claimedFields: [
      {
        field: "Would you now or in the future require a visa for employment?",
        source: "application-memory",
        selectedOption: "No",
        sourceFact: "No visa sponsorship needed",
      },
    ],
  });
  assert.equal(assessment.unverifiedClaims.length, 0);
  assert.equal(assessment.verifiedFields[0].value, "No");
  assert.equal(assessment.complete, true);
});

test("a retained binary value must match the option the model reported", () => {
  const assessment = assessFormCompletion({
    fields: [
      {
        index: 0,
        tag: "binary-group",
        type: "selection",
        label: "Will you require visa sponsorship?",
        required: true,
        checked: true,
        value: "Yes",
      },
    ],
    claimedFields: [
      {
        field: "Will you require visa sponsorship?",
        source: "application-memory",
        selectedOption: "No",
        sourceFact: "No visa sponsorship needed",
      },
    ],
  });
  assert.equal(assessment.verifiedFields.length, 0);
  assert.equal(assessment.unverifiedClaims.length, 1);
  assert.match(assessment.unverifiedClaims[0].reason, /holds "Yes".*"No"/);
  assert.equal(assessment.complete, false);
});

test("similar fixed-option wording does not verify the wrong option", () => {
  const assessment = assessFormCompletion({
    fields: [
      {
        index: 0,
        tag: "select",
        type: "select",
        label: "Immigration status",
        required: true,
        value: "Yes - Student Visa",
      },
    ],
    claimedFields: [
      {
        field: "Immigration status",
        source: "application-memory",
        selectedOption: "Yes - Graduate Visa",
        sourceFact: "Graduate Visa",
      },
    ],
  });
  assert.equal(assessment.verifiedFields.length, 0);
  assert.equal(assessment.unverifiedClaims.length, 1);
  assert.equal(assessment.complete, false);
});

test("a generic visa token cannot justify a different specific status", () => {
  const assessment = assessFormCompletion({
    fields: [
      {
        index: 0,
        tag: "select",
        type: "select",
        label: "Immigration status",
        required: true,
        value: "Yes - Student Visa",
      },
    ],
    claimedFields: [
      {
        field: "Immigration status",
        source: "application-memory",
        selectedOption: "Yes - Student Visa",
        sourceFact: "Graduate Visa",
      },
    ],
  });
  assert.equal(assessment.verifiedFields.length, 0);
  assert.match(assessment.unverifiedClaims[0].reason, /not supported/);
});

test("a fixed-choice claim without selectedOption is never verified", () => {
  const assessment = assessFormCompletion({
    fields: [
      {
        index: 0,
        tag: "binary-group",
        type: "selection",
        label: "Will you require visa sponsorship?",
        required: true,
        value: "No",
      },
    ],
    claimedFields: [{ field: "Will you require visa sponsorship?", source: "application-memory" }],
  });
  assert.equal(assessment.verifiedFields.length, 0);
  assert.match(assessment.unverifiedClaims[0].reason, /did not report which fixed option/);
  assert.equal(assessment.complete, false);
});

test("a retained fixed choice with inverted meaning is rejected", () => {
  const assessment = assessFormCompletion({
    fields: [
      {
        index: 0,
        tag: "binary-group",
        type: "selection",
        label: "Are you authorized to work in the UK?",
        required: true,
        value: "No",
      },
    ],
    claimedFields: [
      {
        field: "Are you authorized to work in the UK?",
        source: "application-memory",
        selectedOption: "No",
        sourceFact: "Authorized to work in the UK with pre-settled status",
      },
    ],
  });
  assert.equal(assessment.verifiedFields.length, 0);
  assert.match(assessment.unverifiedClaims[0].reason, /not supported/);
});

test("a no-sponsorship fact cannot justify denying UK work authorization", () => {
  const assessment = assessFormCompletion({
    fields: [
      {
        index: 0,
        tag: "binary-group",
        type: "selection",
        label: "Are you authorized to work in the UK?",
        required: true,
        value: "No",
      },
    ],
    claimedFields: [
      {
        field: "Are you authorized to work in the UK?",
        source: "application-memory",
        selectedOption: "No",
        sourceFact: "No visa sponsorship needed",
      },
    ],
  });
  assert.equal(assessment.verifiedFields.length, 0);
  assert.match(assessment.unverifiedClaims[0].reason, /not supported/);
});

test("standalone checkboxes stay individual fields", () => {
  // A consent checkbox is its own question and must keep its own wording.
  const fields = collapseChoiceGroups([
    { index: 0, tag: "input", type: "checkbox", name: "gdpr", label: "I agree", required: true, checked: true, value: "checked" },
    { index: 1, tag: "input", type: "checkbox", name: "updates", label: "Send me updates", required: false, checked: false, value: "" },
  ]);
  assert.equal(fields.length, 2);
  assert.deepEqual(fields.map((field) => field.label), ["I agree", "Send me updates"]);
});

test("a required checkbox list is one question, not one blocker per box", () => {
  // Greenhouse marks every box in a required multi-select `required`. Counted per box, a
  // 35-skill question arrived as 35 blockers named "Accounting", "Agile", "API" — none of
  // which any answer could clear.
  const skills = ["Accounting", "Agile", "API", "AWS"].map((skill, index) => ({
    index,
    tag: "input",
    type: "checkbox",
    name: "question_8310594006[]",
    label: skill,
    groupLabel: "Which programming languages, tools, and technologies are your strongest?",
    required: true,
    checked: skill === "API" || skill === "AWS",
    value: skill === "API" || skill === "AWS" ? skill : "",
  }));
  const [group, ...rest] = collapseChoiceGroups(skills);
  assert.equal(rest.length, 0);
  assert.equal(group.tag, "checkboxgroup");
  assert.equal(group.label, "Which programming languages, tools, and technologies are your strongest?");
  // Several boxes can be ticked at once, unlike a radio group.
  assert.equal(group.value, "API, AWS");
  assert.equal(group.optionCount, 4);
  assert.equal(assessFormCompletion({ fields: [group], claimedFields: [] }).blockingFields.length, 0);
});

test("an untouched required checkbox list blocks once, under the question", () => {
  const fields = collapseChoiceGroups([
    { index: 0, tag: "input", type: "checkbox", name: "skills[]", label: "Accounting", groupLabel: "Strongest skills?", required: true, checked: false, value: "" },
    { index: 1, tag: "input", type: "checkbox", name: "skills[]", label: "Agile", groupLabel: "Strongest skills?", required: true, checked: false, value: "" },
  ]);
  assert.deepEqual(
    assessFormCompletion({ fields, claimedFields: [] }).blockingFields.map((entry) => entry.field),
    ["Strongest skills?"],
  );
});

test("a committed dropdown choice counts even when the widget renders it as a code", () => {
  // Live on Greenhouse: choosing United Kingdom leaves the search input empty and renders a
  // flag plus "+44". Comparing that to the reported option can only test commitment.
  assert.equal(optionMatchesPageValue("+44", "United Kingdom"), true);
  assert.equal(optionMatchesPageValue("Yes - Settled/pre-settled status", "Yes — Settled/Pre-settled status"), true);
  // An empty field is never a committed choice, and a different answer is still a mismatch.
  assert.equal(optionMatchesPageValue("", "United Kingdom"), false);
  assert.equal(optionMatchesPageValue("No", "Yes"), false);
});

test("labels match across case, punctuation, stars, and partial wording", () => {
  assert.equal(labelsMatch("Phone Number *", "phone number"), true);
  assert.equal(labelsMatch("E-mail address (required)", "email address"), false);
  assert.equal(labelsMatch("First name", "First Name:"), true);
  assert.equal(labelsMatch("Do you have the right to work in the UK?", "right to work in the UK"), true);
  assert.equal(labelsMatch("Cover note", "Salary expectation"), false);
  assert.equal(normalizeLabel("Yes - Settled/pre-settled status"), "yes settled pre settled status");
});

test("option matching is tolerant of wording but strict about meaning", () => {
  const visaOptions = [
    "I need Visa Sponsorship",
    "No",
    "Other",
    "Yes - Graduate Visa",
    "Yes - In date British or Irish Passport",
    "Yes - Out of date British or Irish Passport",
    "Yes - Settled/pre-settled status",
    "Yes - Student Visa",
    "Yes- Dependant Visa",
  ];
  // The memory says "pre-settled status"; the form writes it differently.
  assert.equal(matchOption(visaOptions, "pre-settled status"), "Yes - Settled/pre-settled status");
  assert.equal(matchOption(visaOptions, "PRE SETTLED STATUS"), "Yes - Settled/pre-settled status");
  // Nothing in memory entails a passport or a visa, so no option may be chosen.
  assert.equal(matchOption(visaOptions, "authorised to work"), null);
  assert.equal(matchOption(visaOptions, ""), null);
  assert.equal(matchOption(visaOptions, "no visa sponsorship needed"), "No");

  const referralOptions = ["Job Board (e.g. LinkedIn, Indeed, CV Library etc.)", "Referral", "Careers fair", "Other"];
  assert.equal(
    matchOption(referralOptions, "job board"),
    "Job Board (e.g. LinkedIn, Indeed, CV Library etc.)",
  );
  assert.equal(matchOption(referralOptions, "LinkedIn"), "Job Board (e.g. LinkedIn, Indeed, CV Library etc.)");
});

test("an ambiguous option list is refused rather than guessed", () => {
  // Two options fit "graduate" equally well; picking either would invent a fact.
  assert.equal(matchOption(["Yes - Graduate Visa", "Graduate scheme"], "graduate"), null);
});
