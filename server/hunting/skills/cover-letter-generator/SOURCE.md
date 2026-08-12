# Provenance

`SKILL.md` in this directory is vendored verbatim from:

- Repository: https://github.com/Paramchoudhary/ResumeSkills
- File: `skills/cover-letter-generator/SKILL.md`
- Fetched: 2026-07-25

It is used as the *style and structure* guide for `server/hunting/cover-letter-service.js`.

## What Hunting overrides

The skill is generic advice written for a human author. Hunting adds constraints the skill does
not have, and those constraints win wherever the two disagree:

- **Every factual claim must be traceable** to the canonical CV or an approved memory page. The
  skill's advice to include "at least one specific metric" applies only when a real metric exists
  in those sources; a metric is never invented to satisfy the checklist.
- **No invented company knowledge.** The skill's strongest opening hooks assume company research.
  The generator may only use the job listing's own text plus the company and role names, so it
  cannot assert a product launch, funding round, or strategy it has not read.
- **No gap-spinning.** The skill suggests framing gaps with in-progress learning; Hunting states a
  gap only if the CV or memory records that learning.
- **Never claim skills, tools, or seniority** that the CV does not show.

If the vendored file is refreshed from upstream, re-check those four points before relying on it.
