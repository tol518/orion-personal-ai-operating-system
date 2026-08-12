# Provenance

`RULES.md` in this directory is **derived from**, not vendored verbatim from:

- Repository: https://github.com/blader/humanizer
- File: `SKILL.md`
- Read: 2026-07-29
- Which is itself based on Wikipedia's "Signs of AI writing" guide.

It is not a copy. The upstream file was read through a fetch tool that reformats page content, so a
byte-exact copy could not be guaranteed and claiming one would be false. Treat upstream as
canonical; if a rule here disagrees with it, upstream is right.

## What was kept, and why the rest was dropped

Upstream covers 33 patterns for arbitrary AI prose — much of it about documents this repo never
produces. A cover letter is 350 words of continuous first-person prose with no headings, no lists,
no citations and no version history, so these upstream rules cannot fire and are omitted: notability
emphasis, vague attributions, "challenges and future" sections, boldface overuse, inline-header
lists, title case in headings, emojis in headings, fragmented headers, diff-anchored writing.

What was kept is the set that shows up in generated letters: significance inflation, participial
padding, promotional language, AI vocabulary, copula avoidance, negative parallelism, rule-of-three,
synonym cycling, false ranges, passive voice, em/en dashes, curly quotes, chatbot artifacts,
sycophancy, filler phrases, hedging, generic positive conclusions, authority tropes, signposting,
manufactured punchlines, aphorism formulas, and rhetorical openers.

## What Hunting overrides

The cover-letter grounding rules in `server/hunting/cover-letter-service.js` win over both this file
and the cover-letter-generator skill wherever they disagree. Two collisions matter:

- **Upstream's no-fabrication rule is the same as ours and must survive humanizing.** Making a
  sentence sound less mechanical must never add a fact. A letter that reads naturally and claims a
  metric the user does not have is worse than a stiff, true one.
- **Upstream's "voice calibration from a writing sample" is not used.** No verified sample of
  the user's prose exists in this app, so the rules run without one rather than inventing a voice.

British English also stays, since the letters go to UK employers; upstream is written for US usage.
