import { useEffect, useRef, useState } from "react";
import { PlugZap } from "lucide-react";
import type { OrionPlugin, OrionPluginUi } from "../lib/plugin-types";

const moduleLoads = new Map<string, Promise<unknown>>();

function loadPluginModule(url: string): Promise<unknown> {
  const existing = moduleLoads.get(url);
  if (existing) return existing;
  const loading = import(/* @vite-ignore */ url);
  moduleLoads.set(url, loading);
  return loading;
}

export default function PluginPage({ plugin, contribution }: { plugin: OrionPlugin; contribution: OrionPluginUi }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apiBase = plugin.apiBase;
  const elementName = contribution.elementName;
  const moduleUrl = contribution.moduleUrl;

  useEffect(() => {
    let cancelled = false;
    const container = host.current;
    if (!container || !apiBase) return;
    container.replaceChildren();
    setError(null);

    loadPluginModule(moduleUrl)
      .then(() => {
        if (cancelled || !host.current) return;
        if (!customElements.get(elementName)) {
          throw new Error(`Plugin module did not register <${elementName}>`);
        }
        const element = document.createElement(elementName);
        element.setAttribute("api-base", apiBase);
        element.setAttribute("orion-route", contribution.route);
        host.current.replaceChildren(element);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason?.message ?? reason));
      });

    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [apiBase, elementName, moduleUrl, contribution.route]);

  if (error) {
    return (
      <div className="flex min-h-72 items-center justify-center border border-red-400/20 bg-red-400/5 p-8 text-center">
        <div>
          <PlugZap className="mx-auto text-red-300" size={24} />
          <h1 className="mt-3 text-base font-semibold text-gray-100">{plugin.name} could not start</h1>
          <p className="mt-2 max-w-lg font-mono text-xs leading-5 text-red-200/70">{error}</p>
        </div>
      </div>
    );
  }

  return <div ref={host} className="min-w-0" aria-label={contribution.label} />;
}
