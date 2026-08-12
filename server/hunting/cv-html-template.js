const SECTION_TITLES = [
  "Professional Summary",
  "Personal Profile",
  "Work Experience",
  "Technical Skills",
  "Certifications",
  "Qualifications",
  "Achievements",
  "Experience",
  "Education",
  "Projects",
  "Skills",
  "Interests",
  "References",
];

const SKILL_LABELS = [
  "Languages",
  "Frameworks",
  "Developer Tools",
  "Databases",
  "AI IDEs",
  "Libraries",
];

const MONTH = "(?:Jan\\.|Feb\\.|Mar\\.|Apr\\.|May|Jun\\.|Jul\\.|Aug\\.|Sep\\.|Sept\\.|Oct\\.|Nov\\.|Dec\\.|January|February|March|April|June|July|August|September|October|November|December)";
const DATE_RANGE = `${MONTH}\\s+\\d{4}\\s+[\\u2013-]\\s+(?:Present|${MONTH}\\s+\\d{4})`;

export function createCvHtml({ content, sourceName = null, links = [] }) {
  const { preface, sections } = splitSections(cleanText(content));
  const { name, contact } = splitIdentity(preface);
  const title = escapeHtml(sourceName || name || "Curriculum Vitae");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    @page { size: Letter; margin: 0.46in 0.5in 0.56in; }
    * { box-sizing: border-box; }
    html { color: #000; background: #fff; font-family: Georgia, "Times New Roman", serif; }
    body { margin: 0; color: #000; font-size: 10.08pt; line-height: 1.19; }
    header { text-align: center; }
    h1 { margin: 0 0 2pt; font-size: 24.48pt; line-height: 1.05; font-weight: 700; }
    .contact { margin: 0; font-size: 10.08pt; line-height: 1.2; }
    section { break-inside: auto; margin-top: 7pt; }
    h2 { margin: 0 0 5pt; font-size: 12pt; line-height: 1.08; font-weight: 700; }
    .section-copy { margin-left: 10.8pt; }
    p { margin: 0 0 3.2pt; }
    .lead { font-size: 10.08pt; }
    article { break-inside: avoid; margin: 0 0 5pt; }
    .entry-heading { display: flex; justify-content: space-between; gap: 12pt; margin: 0 0 1.5pt; font-size: 10.08pt; }
    .entry-heading strong { min-width: 0; }
    .entry-date { flex: none; font-size: 11.04pt; }
    .entry-organisation { margin: 0 0 2pt; }
    ul { margin: 2pt 0 4pt 24pt; padding: 0; }
    li { margin: 0 0 2.4pt; padding-left: 0; break-inside: avoid; }
    .skill-line { margin: 0 0 1.8pt 10.8pt; }
    strong { font-weight: 700; }
    a {
      color: inherit;
      text-decoration: underline;
      text-decoration-thickness: 0.75pt;
      text-underline-offset: 1.2pt;
    }
  </style>
</head>
<body>
  <header>
    <h1>${renderInline(name || "Curriculum Vitae", links)}</h1>
    ${contact ? `<p class="contact">${renderInline(contact, links)}</p>` : ""}
  </header>
  ${sections.length
    ? sections.map((section) => renderSection(section, links)).join("\n")
    : `<section><div class="section-copy">${renderParagraphs(preface || content, links)}</div></section>`}
</body>
</html>`;
}

function renderSection(section, links) {
  if (section.title === "Projects") return renderProjects(section, links);
  if (section.title === "Experience" || section.title === "Work Experience") {
    return renderExperience(section, links);
  }
  if (section.title === "Technical Skills" || SKILL_LABELS.includes(section.title)) {
    return `<section><h2>${escapeHtml(section.title)}</h2>${renderSkills(section.body, links)}</section>`;
  }
  const pieces = section.body
    .split(/\s+(?:[\u2022\u00b7]|[-*](?=\s))\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const lead = pieces.shift() ?? "";
  return `<section>
    <h2>${escapeHtml(section.title)}</h2>
    <div class="section-copy">
      ${lead ? `<p class="lead">${renderInline(lead, links)}</p>` : ""}
      ${pieces.length ? `<ul>${pieces.map((piece) => `<li>${renderInline(piece, links)}</li>`).join("")}</ul>` : ""}
    </div>
  </section>`;
}

function renderExperience(section, links) {
  const pieces = section.body
    .split(/\s+(?:[\u2022\u00b7]|[-*](?=\s))\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const lead = pieces.shift() ?? "";
  const date = lead.match(new RegExp(DATE_RANGE, "u"));
  if (!date || date.index === undefined) return renderSectionFallback(section, links);
  const title = lead.slice(0, date.index).trim();
  const organisation = lead.slice(date.index + date[0].length).trim();
  return `<section><h2>${escapeHtml(section.title)}</h2><div class="section-copy"><article>
    <p class="entry-heading"><strong>${renderInline(title, links)}</strong><span class="entry-date">${escapeHtml(date[0])}</span></p>
    ${organisation ? `<p class="entry-organisation">${renderInline(organisation, links)}</p>` : ""}
    ${pieces.length ? `<ul>${pieces.map((piece) => `<li>${renderInline(piece, links)}</li>`).join("")}</ul>` : ""}
  </article></div></section>`;
}

function renderProjects(section, links) {
  const headerPattern = new RegExp(`(?:^|(?<=\\.\\s))([^\\u2022]{2,220}?\\s+(${DATE_RANGE}))(?=\\s+(?:\\u2022|$))`, "gu");
  const headers = [...section.body.matchAll(headerPattern)];
  if (!headers.length) return renderSectionFallback(section, links);
  const articles = headers.map((header, index) => {
    const headerStart = header.index ?? 0;
    const headerEnd = headerStart + header[0].length;
    const nextStart = headers[index + 1]?.index ?? section.body.length;
    const title = header[1].slice(0, -header[2].length).trim();
    const bullets = section.body
      .slice(headerEnd, nextStart)
      .replace(/^\s*[\u2022\u00b7*-]?\s*/u, "")
      .split(/\s+(?:[\u2022\u00b7]|[-*](?=\s))\s+/u)
      .map((part) => part.trim())
      .filter(Boolean);
    return `<article>
      <p class="entry-heading"><strong>${renderInline(title, links)}</strong><span class="entry-date">${escapeHtml(header[2])}</span></p>
      ${bullets.length ? `<ul>${bullets.map((bullet) => `<li>${renderInline(bullet, links)}</li>`).join("")}</ul>` : ""}
    </article>`;
  });
  return `<section><h2>${escapeHtml(section.title)}</h2><div class="section-copy">${articles.join("")}</div></section>`;
}

function renderSectionFallback(section, links) {
  const pieces = section.body
    .split(/\s+(?:[\u2022\u00b7]|[-*](?=\s))\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const lead = pieces.shift() ?? "";
  return `<section>
    <h2>${escapeHtml(section.title)}</h2>
    <div class="section-copy">
      ${lead ? `<p class="lead">${renderInline(lead, links)}</p>` : ""}
      ${pieces.length ? `<ul>${pieces.map((piece) => `<li>${renderInline(piece, links)}</li>`).join("")}</ul>` : ""}
    </div>
  </section>`;
}

function renderSkills(body, links) {
  const marker = new RegExp(`(?:^|\\s)(${SKILL_LABELS.map(escapeRegExp).join("|")})\\s*:\\s*`, "g");
  const matches = [...body.matchAll(marker)];
  if (!matches.length) return `<p class="skill-line">${renderInline(body, links)}</p>`;
  return matches
    .map((match, index) => {
      const start = match.index + match[0].length;
      const end = matches[index + 1]?.index ?? body.length;
      return `<p class="skill-line"><strong>${escapeHtml(match[1])}:</strong> ${renderInline(body.slice(start, end).trim(), links)}</p>`;
    })
    .join("");
}

function renderParagraphs(value, links) {
  return value
    .split(/\n{2,}/u)
    .map((paragraph) => `<p>${renderInline(paragraph.replace(/\s+/gu, " ").trim(), links)}</p>`)
    .join("");
}

function renderInline(value, links) {
  const source = String(value ?? "");
  const candidates = links
    .map((link) => ({
      ...link,
      label: String(link?.label ?? "").trim(),
      href: linkHref(link),
    }))
    .filter((link) => link.label && link.href)
    .filter((link) => link.label.length > 1)
    .sort((left, right) => right.label.length - left.label.length);
  let cursor = 0;
  let output = "";
  while (cursor < source.length) {
    let selected = null;
    for (const link of candidates) {
      const range = flexibleRange(source, link.label, cursor);
      if (!range) continue;
      if (!selected || range.start < selected.range.start || (range.start === selected.range.start && range.end > selected.range.end)) {
        selected = { range, link };
      }
    }
    if (!selected) {
      output += escapeHtml(source.slice(cursor));
      break;
    }
    output += escapeHtml(source.slice(cursor, selected.range.start));
    const label = source.slice(selected.range.start, selected.range.end);
    output += `<a href="${escapeHtml(selected.link.href)}">${escapeHtml(label)}</a>`;
    cursor = selected.range.end;
  }
  return output || escapeHtml(source);
}

function flexibleRange(source, label, cursor) {
  const compactLabel = compactLinkText(label);
  if (!compactLabel) return null;
  let compactSource = "";
  const sourceOffsets = [];
  for (let index = cursor; index < source.length; index += 1) {
    const character = source[index];
    if (/\s/u.test(character)) continue;
    compactSource += character.toLocaleLowerCase("en-US");
    sourceOffsets.push(index);
  }
  const compactIndex = compactSource.indexOf(compactLabel);
  if (compactIndex < 0) return null;
  return {
    start: sourceOffsets[compactIndex],
    end: sourceOffsets[compactIndex + compactLabel.length - 1] + 1,
  };
}

function compactLinkText(value) {
  return String(value ?? "").replace(/\s+/gu, "").toLocaleLowerCase("en-US");
}

function linkHref(link) {
  if (validHttpsUrl(link?.url)) return String(link.url);
  const email = String(link?.label ?? "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return `mailto:${email}`;
  return null;
}

function splitSections(content) {
  const markers = [];
  for (const title of SECTION_TITLES) {
    const pattern = new RegExp(`(?:^|\\s|#+)${escapeRegExp(title)}(?=\\s|$)`, "g");
    for (const match of content.matchAll(pattern)) {
      const leading = match[0].length - title.length;
      markers.push({ index: match.index + leading, title });
    }
  }
  markers.sort((left, right) => left.index - right.index || right.title.length - left.title.length);
  const distinct = markers.filter((marker, index) => {
    const previous = markers[index - 1];
    return !previous || marker.index >= previous.index + previous.title.length;
  });
  if (!distinct.length) return { preface: content.trim(), sections: [] };
  return {
    preface: content.slice(0, distinct[0].index).replace(/#+\s*$/u, "").trim(),
    sections: distinct.map((marker, index) => ({
      title: marker.title,
      body: content
        .slice(marker.index + marker.title.length, distinct[index + 1]?.index ?? content.length)
        .replace(/^\s*[:|-]?\s*/u, "")
        .trim(),
    })),
  };
}

function splitIdentity(preface) {
  const compact = preface.replace(/^#+\s*/u, "").replace(/\s+/gu, " ").trim();
  if (!compact) return { name: "", contact: "" };
  const contact = compact.match(/(?:\+?\d[\d\s()]{6,}|[\w.+-]+@[\w.-]+|(?:https?:\/\/)?(?:www\.)?(?:linkedin|github)\.)/iu);
  if (!contact || contact.index === undefined || contact.index < 2) {
    const [firstLine, ...rest] = preface.split("\n").map((line) => line.trim()).filter(Boolean);
    return { name: firstLine ?? "", contact: rest.join(" | ") };
  }
  return {
    name: compact.slice(0, contact.index).trim().replace(/[|,;-]+$/u, "").trim(),
    contact: compact.slice(contact.index).trim().replace(/\s*\|\s*/gu, " | "),
  };
}

function validHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
