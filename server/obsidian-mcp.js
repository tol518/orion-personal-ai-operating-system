import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 12_000;

function contentText(result) {
  return (result?.content ?? [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export class ObsidianMcpClient {
  constructor({ command, args, vault, requestTimeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.command = command;
    this.args = args;
    this.vault = vault;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.lastError = null;
  }

  get configured() {
    return Boolean(this.command && this.args.length > 0 && this.vault);
  }

  get connected() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  async start() {
    if (this.connected) return;
    if (!this.configured) throw new Error("Obsidian MCP is not configured");
    if (this.starting) return this.starting;
    this.starting = this.#spawnAndInitialize();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  stop() {
    this.child?.kill();
    this.child = null;
    this.#rejectPending(new Error("Obsidian MCP stopped"));
  }

  async listNotes(prefix = "") {
    const text = contentText(await this.callTool("list_notes", { prefix }));
    if (!text || text === "No matching Markdown notes.") return [];
    return text
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async readNote(notePath) {
    return contentText(await this.callTool("read_note", { path: notePath }));
  }

  async writeNote(notePath, content, overwrite) {
    await this.callTool("write_note", { path: notePath, content, overwrite });
  }

  async appendNote(notePath, content, createIfMissing = false) {
    await this.callTool("append_note", {
      path: notePath,
      content,
      create_if_missing: createIfMissing,
    });
  }

  async deleteNote(notePath) {
    await this.callTool("delete_note", { path: notePath });
  }

  async searchNotes(query, maxResults = 20) {
    return contentText(
      await this.callTool("search_notes", { query, max_results: maxResults }),
    );
  }

  async callTool(name, args) {
    await this.start();
    return this.#request("tools/call", { name, arguments: args });
  }

  async #spawnAndInitialize() {
    const child = spawn(this.command, this.args, {
      env: { ...process.env, OBSIDIAN_VAULT: this.vault },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.lastError = null;

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#handleLine(line));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.lastError = message;
    });
    child.on("error", (error) => {
      this.lastError = error.message;
      this.#rejectPending(error);
    });
    child.on("exit", () => {
      this.child = null;
      this.#rejectPending(new Error("Obsidian MCP process exited"));
    });

    await this.#request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jarvis-bff", version: "0.2.0" },
    });
    this.#notify("notifications/initialized", {});
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "MCP request failed"));
    else pending.resolve(message.result);
  }

  #request(method, params) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Obsidian MCP is unavailable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Obsidian MCP ${method} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  #notify(method, params) {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
