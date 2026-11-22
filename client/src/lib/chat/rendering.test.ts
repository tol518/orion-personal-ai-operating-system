import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Bubble } from "../../components/chat/Bubble";

it("renders assistant markdown, safe links, fenced code and memory citations", () => {
  const html = renderToStaticMarkup(
    createElement(Bubble, {
      role: "agent",
      text: "# Result\n\n[Notes](https://example.org)\n\n```ts\nlet count=1\n```\n\n<script>alert(1)</script>",
      memoryCitations: [{ id: "m", title: "Project notes" }],
    }),
  );
  expect(html).toContain("<h1>Result</h1>");
  expect(html).toContain('target="_blank" rel="noreferrer noopener"');
  expect(html).toContain("<code>let count=1</code>");
  expect(html).toContain("Memories used");
  expect(html).not.toContain("<script");
});
it("leaves user text literal", () => {
  const html = renderToStaticMarkup(
    createElement(Bubble, { role: "user", text: "**hello** <img src=x>" }),
  );
  expect(html).toContain("**hello** &lt;img src=x&gt;");
});
