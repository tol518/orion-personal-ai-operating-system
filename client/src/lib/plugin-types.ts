export type OrionPluginUi = {
  route: string;
  label: string;
  description: string;
  icon: "chart" | "flask" | "landmark" | "plug";
  elementName: string;
  modulePath: string;
  moduleUrl: string;
};

export type OrionPlugin = {
  id: string;
  name: string;
  version: string;
  description: string;
  apiBase: string | null;
  ui: OrionPluginUi[];
};

export type OrionPluginManifest = {
  ok: true;
  plugins: OrionPlugin[];
  errors: Array<{ path: string; detail: string }>;
};
