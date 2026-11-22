import { Children, isValidElement, useEffect, useId, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown.css";

export function Copy({ text }: { text: string }) {
  const [label, setLabel] = useState("Copy");
  useEffect(() => {
    if (label === "Copy") return;
    const timer = setTimeout(() => setLabel("Copy"), 1800);
    return () => clearTimeout(timer);
  }, [label]);
  return (
    <button
      type="button"
      className="text-xs text-gray-400 hover:text-white"
      onClick={() =>
        Promise.resolve()
          .then(() => navigator.clipboard.writeText(text))
          .then(
            () => setLabel("Copied"),
            () => setLabel("Copy failed"),
          )
      }
    >
      {label}
    </button>
  );
}

function Diagram({ source }: { source: string }) {
  const id = useId().replace(/:/g, "");
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setUrl("");
    async function render() {
      const { default: mermaid } = await import("mermaid");
      if (!active) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
      });
      const { svg } = await mermaid.render("diagram-" + id, source);
      if (active) {
        objectUrl = URL.createObjectURL(
          new Blob([svg], { type: "image/svg+xml" }),
        );
        setUrl(objectUrl);
      }
    }
    render().catch(() => {});
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, source]);
  return url ? (
    <img
      className="max-w-full rounded bg-white"
      alt="Mermaid diagram"
      src={url}
    />
  ) : (
    <pre>
      <code>{source}</code>
    </pre>
  );
}

const components: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  pre: ({ children }) => {
    const child = Children.toArray(children)[0];
    if (!isValidElement(child)) return <pre>{children}</pre>;
    const language = child.props.className?.replace(/^language-/, "") ?? "text";
    const source = String(child.props.children ?? "").replace(/\n$/, "");
    return (
      <section className="my-2 rounded border border-hudborder bg-black/30 p-2">
        <div className="flex justify-between text-xs text-gray-400">
          {language}
          <Copy text={source} />
        </div>
        {language === "mermaid" ? (
          <Diagram source={source} />
        ) : (
          <pre>
            <code>{source}</code>
          </pre>
        )}
      </section>
    );
  },
};
export function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
