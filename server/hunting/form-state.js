// What the application form actually holds, read from the page rather than reported.
//
// A model said it had answered the right-to-work question when the form still held nothing:
// the field was a searchable combobox, and typing into it without picking an option leaves it
// empty. The lesson is the same one the upload service learned — a claim is not evidence — so
// completion is judged here, against the live form.
//
// Required/optional also comes from the page (the `required` attribute, aria-required, or a
// starred label), because whether a blank field blocks the application is a fact about the
// form, not an opinion of the model's.
import { isEvaluateDisabledError } from "./browser-control.js";

// Scanned before grouping, so a form whose skill list alone is 60 checkboxes still gets read to
// the end; the collapsed result is what the checkpoint reports.
const MAX_NODES = 400;
const MAX_FIELDS = 120;

/** Read every user-editable field in the current document. */
export async function readFormState({ browser, targetId }) {
  const result = await browser.evaluate({
    targetId,
    fn: `() => {
      const labelFor = (el) => {
        if (el.labels && el.labels[0] && el.labels[0].textContent) return el.labels[0].textContent;
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        const described = el.getAttribute('aria-labelledby');
        if (described) {
          const owner = document.getElementById(described);
          if (owner && owner.textContent) return owner.textContent;
        }
        const wrapper = el.closest('label, .field, [class*="field"], [class*="form-group"]');
        if (wrapper && wrapper.textContent) return wrapper.textContent;
        return el.getAttribute('placeholder') || el.name || el.id || '';
      };
      const isRequired = (el, label) => {
        if (el.required || el.getAttribute('aria-required') === 'true') return true;
        const group = el.closest('[role="radiogroup"], [role="group"]');
        if (group && group.getAttribute('aria-required') === 'true') return true;
        const wrapper = el.closest('label, .field, [class*="field"], [class*="form-group"]');
        if (wrapper && wrapper.getAttribute('aria-required') === 'true') return true;
        const marker = (wrapper && wrapper.textContent) || label || '';
        // A starred or "(required)" label is the common non-attribute convention.
        return /\\*\\s*$|\\*\\s|\\(required\\)|\\brequired\\b/i.test(marker.slice(0, 200));
      };
      // A radio or checkbox's own label is the option text ("Accounting"), not the question.
      // The question lives on the group, so it is read separately and the options collapsed below.
      const groupLabelFor = (el) => {
        const legend = el.closest('fieldset') && el.closest('fieldset').querySelector('legend');
        if (legend && legend.textContent) return legend.textContent;
        const group = el.closest('[role="radiogroup"], [role="group"]');
        if (group && group.getAttribute('aria-label')) return group.getAttribute('aria-label');
        const described = group && group.getAttribute('aria-labelledby');
        if (described) {
          const owner = document.getElementById(described);
          if (owner && owner.textContent) return owner.textContent;
        }
        const wrapper = el.closest('.field, [class*="field"], [class*="form-group"], [class*="question"]');
        if (wrapper) {
          // Strip the option labels so only the question text is left.
          const options = Array.from(wrapper.querySelectorAll('label')).map((node) => node.textContent || '');
          let text = wrapper.textContent || '';
          for (const option of options) {
            if (option.trim()) text = text.split(option).join(' ');
          }
          if (text.trim()) return text;
        }
        return el.getAttribute('name') || '';
      };
      // React-select renders a hidden, unlabelled, required proxy input per combobox purely to
      // trigger the browser's native validation bubble. It has a box and so passes a visibility
      // test, but it is not a question: counted as one, every dropdown on a Greenhouse form
      // became a second required field that can never be filled directly.
      const isDecorative = (el) => {
        if (el.getAttribute('aria-hidden') === 'true') return true;
        if (el.tabIndex !== -1) return false;
        const style = getComputedStyle(el);
        return style.opacity === '0' || style.pointerEvents === 'none' || style.visibility === 'hidden';
      };
      const nodes = Array.from(
        document.querySelectorAll(
          'input, textarea, select, [role="combobox"], [role="radio"], [role="checkbox"], [role="switch"], [aria-pressed="true"], [data-state="checked"], [data-state="on"], [contenteditable="true"]',
        ),
      ).filter((el) => {
        const type = (el.getAttribute('type') || '').toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        const dataState = (el.getAttribute('data-state') || '').toLowerCase();
        const isStateControl =
          ['radio', 'checkbox', 'switch'].includes(role) ||
          el.getAttribute('aria-pressed') === 'true' ||
          ['checked', 'on'].includes(dataState);
        if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type) && !isStateControl) return false;
        // A file input is deliberately hidden behind a styled button on almost every form.
        if (type !== 'file' && isDecorative(el)) return false;
        return Boolean(el.offsetParent) || el.getClientRects().length > 0 || type === 'file';
      });
      // A committed combobox choice lives in the widget's rendered value, not in the search
      // input, whose text is cleared on selection. Reading el.value made every answered dropdown
      // look untouched, so the run asked the user to re-answer questions it had already answered.
      const comboboxValue = (el) => {
        const container = el.closest(
          '[class*="value-container"], [class*="valueContainer"], [class*="control"], [class*="select-shell"], [class*="combobox"]',
        );
        if (!container) return '';
        const single = container.querySelector('[class*="single-value"], [class*="singleValue"]');
        if (single && single.textContent) return single.textContent;
        const chips = Array.from(container.querySelectorAll('[class*="multi-value__label"], [class*="multiValue"]'))
          .map((chip) => (chip.textContent || '').trim())
          .filter(Boolean);
        return chips.join(', ');
      };
      const nodeFields = nodes.slice(0, ${MAX_NODES}).map((el, index) => {
        const tag = el.tagName.toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        const inputType = (el.getAttribute('type') || '').toLowerCase();
        const dataState = (el.getAttribute('data-state') || '').toLowerCase();
        const semanticType =
          role === 'radio'
            ? 'radio'
            : role === 'checkbox' || role === 'switch'
              ? 'checkbox'
              : el.getAttribute('aria-pressed') === 'true' || ['checked', 'on'].includes(dataState)
                ? 'selection'
                : '';
        const type = (tag === 'input' && inputType) || semanticType || inputType || tag;
        const optionLabel = String(el.getAttribute('aria-label') || el.textContent || labelFor(el) || '')
          .replace(/\\s+/g, ' ')
          .trim()
          .slice(0, 160);
        const groupLabel =
          ['radio', 'selection', 'checkbox'].includes(type)
            ? String(groupLabelFor(el) || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
            : null;
        const label = String(
          type === 'selection' ? groupLabel || labelFor(el) : type === 'radio' ? optionLabel : labelFor(el) || '',
        )
          .replace(/\\s+/g, ' ')
          .trim()
          .slice(0, 160);
        const checked =
          el.checked === true ||
          el.getAttribute('aria-checked') === 'true' ||
          el.getAttribute('aria-pressed') === 'true' ||
          ['checked', 'on'].includes(dataState);
        let value = '';
        if (tag === 'select') {
          const committed = Array.from(el.selectedOptions || []).filter(
            (option) => String(option.value || '').trim() && !option.disabled,
          );
          value = el.validity && el.validity.valueMissing
            ? ''
            : committed.map((option) => option.textContent.trim()).join(', ');
        } else if (type === 'checkbox' || type === 'radio') {
          value = checked ? (optionLabel || el.value || 'checked') : '';
        } else if (type === 'selection') {
          value = checked ? (optionLabel || 'selected') : '';
        } else if (type === 'file') {
          value = el.files && el.files[0] ? el.files[0].name : '';
        } else if (el.isContentEditable) {
          value = String(el.textContent || '');
        } else if (role === 'combobox') {
          value = comboboxValue(el) || String(el.value || '');
        } else {
          value = String(el.value || '');
        }
        return {
          index,
          tag,
          type,
          label,
          name: el.getAttribute('name') || el.id || null,
          required: isRequired(el, label),
          value: value.replace(/\\s+/g, ' ').trim().slice(0, 240),
          checked: ['checkbox', 'radio', 'selection'].includes(type) ? checked : null,
          groupLabel: ['radio', 'checkbox'].includes(type) ? groupLabel : null,
          // Needed to pick a file format a file-only field will actually take.
          accept: el.getAttribute('accept') || null,
          optionCount: tag === 'select' ? (el.options ? el.options.length : 0) : null,
        };
      });
      // Ashby and similar forms render a binary question as two plain buttons backed by a
      // visually hidden checkbox. Neither button has an ARIA state, so inspect the pair as one
      // field. Identical button state means unanswered; a unique selected marker or a checked
      // backing input is required before the value is accepted.
      const seenBinaryQuestions = new Set();
      const customBinaryFields = Array.from(document.querySelectorAll('label, legend'))
        .map((question, offset) => {
          const questionText = String(question.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
          if (!questionText || seenBinaryQuestions.has(questionText)) return null;
          let container = question.parentElement;
          let buttons = [];
          for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
            buttons = Array.from(container.querySelectorAll('button')).filter(
              (button) => Boolean(button.offsetParent) || button.getClientRects().length > 0,
            );
            const choices = buttons.map((button) => String(button.textContent || '').trim().toLowerCase());
            if (choices.length === 2 && choices.includes('yes') && choices.includes('no')) break;
            buttons = [];
          }
          if (buttons.length !== 2 || !container) return null;
          seenBinaryQuestions.add(questionText);
          const explicitlySelected = buttons.filter((button) => {
            const stateClass = String(button.className || '')
              .split(/\\s+/)
              .some((token) => /selected|active|checked|chosen/i.test(token));
            return (
              stateClass ||
              button.getAttribute('aria-pressed') === 'true' ||
              button.getAttribute('aria-checked') === 'true' ||
              ['checked', 'on', 'selected'].includes(String(button.getAttribute('data-state') || '').toLowerCase())
            );
          });
          const backingInput = container.querySelector('input[type="checkbox"], input[type="radio"]');
          let selected =
            explicitlySelected.length === 1 ? String(explicitlySelected[0].textContent || '').trim() : '';
          if (!selected && backingInput && backingInput.checked === true) selected = 'Yes';
          return {
            index: nodeFields.length + offset,
            tag: 'binary-group',
            type: 'selection',
            label: questionText,
            name: (backingInput && (backingInput.getAttribute('name') || backingInput.id)) || null,
            required:
              isRequired(backingInput || question, questionText) ||
              /required/i.test(String(question.className || '')),
            value: selected.slice(0, 240),
            checked: Boolean(selected),
            groupLabel: null,
            accept: null,
            optionCount: 2,
          };
        })
        .filter(Boolean);
      const backingNames = new Set(customBinaryFields.map((field) => field.name).filter(Boolean));
      const dedupedNodeFields = nodeFields.filter(
        (field) => !(['checkbox', 'radio'].includes(field.type) && field.name && backingNames.has(field.name)),
      );
      return [...dedupedNodeFields, ...customBinaryFields].slice(0, ${MAX_NODES});
    }`,
  });
  if (!result.ok) {
    return {
      available: false,
      evaluateDisabled: isEvaluateDisabledError(result.error),
      error: result.error,
      fields: [],
    };
  }
  const rawFields = result.payload?.result;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return {
      available: false,
      evaluateDisabled: false,
      error: "the live page exposed no application fields",
      fields: [],
    };
  }
  return {
    available: true,
    evaluateDisabled: false,
    error: null,
    fields: collapseChoiceGroups(rawFields).slice(0, MAX_FIELDS),
  };
}

/**
 * One group of options is one question, not one field per option.
 *
 * Read per option, the unselected siblings of an answered radio group look like empty required
 * fields — which is how an application that had already answered "Where did you hear about
 * us?" was sent back to the user asking for it again. A required checkbox list is worse: every
 * box carries the group's `required`, so a 35-skill question arrived as 35 unfillable blockers
 * ("Accounting: required by the form and still empty") that no answer could ever clear.
 *
 * A lone checkbox is its own question — consent boxes must keep their own wording — so only
 * groups with more than one member collapse under the group's label.
 */
export function collapseChoiceGroups(fields) {
  const collapsed = [];
  const groups = new Map();
  for (const field of fields) {
    if (field.type !== "radio" && field.type !== "checkbox") {
      collapsed.push(field);
      continue;
    }
    const key = field.name || field.groupLabel || `${field.type}-${field.index}`;
    const existing = groups.get(key);
    if (!existing) {
      const group = {
        ...field,
        tag: field.type === "radio" ? "radiogroup" : "checkboxgroup",
        // Held so a group that stays at one member can fall back to its own label.
        optionLabel: field.label,
        // The chosen option is the group's value; an unanswered group has none.
        value: field.checked ? field.label || field.value || "checked" : "",
        optionCount: 1,
      };
      groups.set(key, group);
      collapsed.push(group);
      continue;
    }
    existing.optionCount += 1;
    // Any member marked required makes the question required.
    existing.required = existing.required || field.required;
    if (field.checked) {
      const chosen = field.label || field.value || "checked";
      // A checkbox list can hold several answers at once; a radio group holds exactly one.
      existing.value =
        existing.type === "checkbox" && existing.value ? `${existing.value}, ${chosen}` : chosen;
    }
  }
  for (const group of groups.values()) {
    group.label = group.optionCount > 1 ? group.groupLabel || group.optionLabel : group.optionLabel;
    if (group.optionCount === 1) group.tag = group.type;
    delete group.optionLabel;
  }
  return collapsed;
}

/**
 * Compare what the model says it filled with what the form holds.
 *
 * A claim with no matching non-empty field is dropped rather than believed. A blank required
 * field blocks review; a blank optional field is simply skipped, because stopping the whole
 * application over an optional "cover note" wastes the user's time.
 */
export function assessFormCompletion({ fields, claimedFields = [] }) {
  const answered = fields.filter((field) => field.value);

  const verifiedFields = [];
  const unverifiedClaims = [];
  for (const claim of claimedFields) {
    const label = typeof claim === "string" ? claim : claim?.field;
    const match = answered.find((field) => labelsMatch(field.label, label) || labelsMatch(field.name, label));
    if (match) {
      const selectedOption = typeof claim === "string" ? null : claim?.selectedOption;
      const fixedChoice = ["radio", "selection", "select"].includes(match.type) || match.tag === "radiogroup";
      if (fixedChoice && !selectedOption) {
        unverifiedClaims.push({
          field: String(label ?? "unnamed field"),
          reason: "the model did not report which fixed option it selected",
        });
        continue;
      }
      if (selectedOption && !optionMatchesPageValue(match.value, selectedOption)) {
        unverifiedClaims.push({
          field: String(label ?? "unnamed field"),
          reason: `the form holds "${match.value}" instead of the reported option "${selectedOption}"`,
        });
        continue;
      }
      const sourceFact = typeof claim === "string" ? null : claim?.sourceFact;
      if (fixedChoice && !selectionMatchesSourceFact(match.label, selectedOption, sourceFact)) {
        unverifiedClaims.push({
          field: String(label ?? "unnamed field"),
          reason: "the reported fixed option is not supported by a structured source fact",
        });
        continue;
      }
      verifiedFields.push({
        field: typeof claim === "string" ? claim : claim.field,
        source: typeof claim === "string" ? "unstated" : (claim.source ?? "unstated"),
        value: match.value.slice(0, 120),
      });
    } else {
      unverifiedClaims.push({
        field: String(label ?? "unnamed field"),
        reason: "the form holds no value for this field",
      });
    }
  }

  // File fields count here too: by assessment time the upload service and the attachment
  // repair have both had their turn, so an empty required file field is a genuine blocker.
  const blockingFields = fields
    .filter((field) => field.required && !field.value)
    .map((field) => ({
      field: field.label || field.name || `field ${field.index}`,
      reason: field.type === "file" ? "required file is not attached" : "required by the form and still empty",
      required: true,
    }));
  const skippedOptional = fields
    .filter((field) => !field.required && !field.value)
    .map((field) => ({
      field: field.label || field.name || `field ${field.index}`,
      reason: field.type === "file" ? "optional file left unattached" : "optional and left blank",
      required: false,
    }));

  return {
    verifiedFields,
    unverifiedClaims,
    blockingFields,
    skippedOptional,
    // Every claim that survived plus no empty required field means the form is genuinely done.
    complete: blockingFields.length === 0 && unverifiedClaims.length === 0,
    counts: {
      fields: fields.length,
      answered: answered.length,
      required: fields.filter((field) => field.required).length,
    },
  };
}

/**
 * Does the form hold the option the model says it chose?
 *
 * Exact text is the strong answer, but a widget renders a committed choice however it likes:
 * Greenhouse's country selector shows a flag and "+44" for United Kingdom. There is no wording
 * to compare there, so a committed value with no letters in it stands as proof of commitment
 * only — which is still more than the empty search input the old reader saw.
 */
export function optionMatchesPageValue(pageValue, selectedOption) {
  const page = normalizeOption(pageValue);
  if (!page) return false;
  if (page === normalizeOption(selectedOption)) return true;
  if (!/[a-z]/.test(page)) return true;
  // Punctuation and dash style drift between the option text and the rendered value, but the
  // wording itself must still match: token overlap would accept "Student Visa" for "Graduate
  // Visa", and picking the wrong immigration status is exactly what this guards against.
  return normalizeLabel(pageValue) === normalizeLabel(selectedOption);
}

function normalizeOption(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A retained click is necessary but not sufficient: its polarity must match the cited fact. */
export function selectionMatchesSourceFact(fieldLabel, selectedOption, sourceFact) {
  const question = normalizeLabel(fieldLabel);
  const option = normalizeOption(selectedOption);
  const fact = normalizeLabel(sourceFact);
  if (!question || !option || !fact) return false;

  const selectedPolarity = option === "yes" ? true : option === "no" ? false : null;
  if (selectedPolarity === null) {
    const genericTokens = new Set(["yes", "no", "visa", "status", "work", "united", "kingdom", "uk"]);
    const optionTokens = new Set(
      normalizeLabel(option)
        .split(" ")
        .filter((token) => token.length > 2 && !genericTokens.has(token)),
    );
    const factTokens = fact
      .split(" ")
      .filter((token) => token.length > 2 && !genericTokens.has(token));
    return factTokens.length > 0 && factTokens.filter((token) => optionTokens.has(token)).length / factTokens.length >= 0.5;
  }

  const sponsorshipQuestion = /\b(visa|sponsor|sponsorship)\b/.test(question);
  const authorizationQuestion = /\b(authorised|authorized|eligible|right to work)\b/.test(question);
  if (sponsorshipQuestion) {
    const factNeedsNoSponsorship =
      /\b(no|not|never|without|dont|doesnt|do not|does not)\b.{0,32}\b(visa|sponsor|sponsorship)\b/.test(fact) ||
      /\b(visa|sponsor|sponsorship)\b.{0,32}\b(not|required no|not required)\b/.test(fact);
    const factNeedsSponsorship =
      !factNeedsNoSponsorship &&
      /\b(require|requires|required|need|needs|needed)\b.{0,32}\b(visa|sponsor|sponsorship)\b/.test(fact);
    if (factNeedsSponsorship || factNeedsNoSponsorship) return selectedPolarity === factNeedsSponsorship;
    return false;
  }
  if (authorizationQuestion) {
    const authorizationSubject = /\b(authorised|authorized|eligible|right to work|pre settled|settled status)\b/.test(fact);
    const factNotAuthorised =
      /\b(no|not|never|without|dont|doesnt|do not|does not)\b.{0,32}\b(authorised|authorized|eligible|right to work)\b/.test(fact) ||
      /\b(authorised|authorized|eligible|right to work)\b.{0,32}\b(no|not|never)\b/.test(fact);
    if (!authorizationSubject) return false;
    return selectedPolarity === !factNotAuthorised;
  }

  const negativeFact = /\b(no|not|never|without|dont|doesnt|do not|does not)\b/.test(fact);
  const questionTokens = new Set(question.split(" ").filter((token) => token.length > 3));
  const sharedSubject = fact.split(" ").some((token) => questionTokens.has(token));
  return sharedSubject && selectedPolarity !== negativeFact;
}

/** Labels differ in case, punctuation, stars, and trailing colons between claim and page. */
export function labelsMatch(pageLabel, claimLabel) {
  const page = normalizeLabel(pageLabel);
  const claim = normalizeLabel(claimLabel);
  if (!page || !claim) return false;
  if (page === claim || page.includes(claim) || claim.includes(page)) return true;
  // Fall back to token overlap so "Phone Number" still matches "phone".
  const pageTokens = new Set(page.split(" ").filter((token) => token.length > 2));
  const claimTokens = claim.split(" ").filter((token) => token.length > 2);
  if (!claimTokens.length || !pageTokens.size) return false;
  const shared = claimTokens.filter((token) => pageTokens.has(token)).length;
  return shared / claimTokens.length >= 0.6;
}

export function normalizeLabel(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\(required\)|\(optional\)/g, " ")
    .replace(/[*:_/\\-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
