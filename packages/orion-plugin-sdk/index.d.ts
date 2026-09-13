import type { Router } from "express";

export type OrionPluginIcon = "chart" | "flask" | "landmark" | "plug";

export type OrionPluginUiContribution = {
  route: string;
  label: string;
  description?: string;
  icon?: OrionPluginIcon;
  elementName: `${string}-${string}`;
  modulePath: string;
};

export type OrionPluginContext = {
  pluginId: string;
  rootDir: string;
  dataDir: string;
  logger: Pick<Console, "info" | "warn" | "error">;
  mountApi(router: Router): string;
  mountAssets(directory: string): string;
  registerUi(contribution: OrionPluginUiContribution): void;
  broadcast(event: string, data: unknown): void;
};

export type OrionPlugin = {
  id: string;
  name: string;
  version: string;
  description?: string;
  initialize(context: OrionPluginContext): Promise<void> | void;
  shutdown?(): Promise<void> | void;
};

export function defineOrionPlugin(plugin: OrionPlugin): OrionPlugin;
