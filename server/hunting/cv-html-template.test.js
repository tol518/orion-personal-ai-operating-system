import assert from "node:assert/strict";
import test from "node:test";
import { createCvHtml } from "./cv-html-template.js";

test("renders the locked Georgia CV template with sections and bullets", () => {
  const html = createCvHtml({
    content: "Example User  exampleUser@example.com  Education  Example University  Projects  Go Playing AI  • First bullet.  • Second bullet.  Technical Skills  Languages: Python  Frameworks: React",
    sourceName: "the user CV.pdf",
    links: [{ label: "Go Playing AI", url: "https://example.com/go" }],
  });
  assert.match(html, /@page \{ size: Letter/);
  assert.match(html, /font-family: Georgia/);
  assert.match(html, /<h2>Projects<\/h2>/);
  assert.match(html, /<li>First bullet\.<\/li>/);
  assert.match(html, /href="https:\/\/example\.com\/go"/);
  assert.match(html, /text-decoration: underline/);
  assert.match(html, /<strong>Languages:<\/strong> Python/);
});

test("preserves links when extracted PDF text changes spacing", () => {
  const html = createCvHtml({
    content: "Example User  exampleUser@example.com  Projects  Go Playing AI   | Python,Git   Oct. 2025 - Present  • Built a model.",
    links: [
      { label: "exampleUser@example.com", url: "exampleUser%40example.com" },
      { label: "Go Playing AI | Python, Git", url: "https://example.com/go" },
    ],
  });
  assert.match(html, /href="mailto:exampleUser@example\.com"/);
  assert.match(html, /href="https:\/\/example\.com\/go">Go Playing AI\s+\| Python,Git<\/a>/);
});

test("escapes untrusted CV markup and ignores unsafe links", () => {
  const html = createCvHtml({
    content: "the user <script>alert(1)</script>  Education  Safe text",
    links: [{ label: "Safe text", url: "javascript:alert(1)" }],
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /javascript:/);
});
