import { randomUUID } from "node:crypto";

const CV_EDITOR_MODEL = "openai/gpt-5.6-terra";
export const CV_EDITOR_SESSION_KEY = "agent:main:dashboard:hunting-cv-editor";

export class CvEditorService {
  constructor({ gateway, timeoutMs = 120_000 }) {
    this.gateway = gateway;
    this.timeoutMs = timeoutMs;
    this.sessionKey = CV_EDITOR_SESSION_KEY;
    this.queue = Promise.resolve();
  }

  ownsSession(sessionKey) {
    return sessionKey === this.sessionKey;
  }

  revise(content, instruction) {
    return this.#enqueue(async () => {
      const response = await this.#run(
        `You edit a user's CV with strict factual accuracy. Use only facts already present in the CV. ` +
          `Never invent employers, dates, qualifications, metrics, contact details, eligibility, or personal data. ` +
          `Apply only the requested change. Return the smallest possible list of operations; ` +
          `do not rewrite or reformat the complete CV. For added bullets, use insert_after with one complete, ` +
          `unique existing sentence as anchor and put only the new bullet text in text. For a wording change, ` +
          `use replace with exact oldText and newText. Every anchor and oldText must be copied byte-for-byte ` +
          `from CURRENT CV and occur exactly once. Preserve every unrelated character, space, bullet, and ordering. ` +
          `If the instruction needs a missing fact, preserve the CV and put the missing fact in warnings. ` +
          `Return only JSON: {"operations":[` +
          `{"type":"insert_after","anchor":"exact existing sentence","text":"  •   new bullet"},` +
          `{"type":"replace","oldText":"exact existing text","newText":"replacement text"}],` +
          `"summary":"one sentence","warnings":["..."]}.\n\n` +
          `EDIT INSTRUCTION:\n${instruction}\n\nCURRENT CV:\n${content}`,
      );
      const parsed = parseJsonObject(response);
      const revised = applyCvOperations(content, parsed?.operations);
      return {
        content: revised,
        summary: String(parsed?.summary ?? "Revision prepared").trim().slice(0, 300),
        warnings: Array.isArray(parsed?.warnings)
          ? parsed.warnings.map((warning) => String(warning).trim()).filter(Boolean).slice(0, 8)
          : [],
      };
    });
  }

  createMemoryDraft(content) {
    return this.#enqueue(async () => {
      const response = await this.#run(
        `Extract a concise, factual professional profile memory from this CV. ` +
          `Use only explicit CV facts. Do not include street address, phone number, email, date of birth, ` +
          `government identifiers, or other unnecessary sensitive data. ` +
          `Return only JSON: {"title":"...","body":"Markdown","tags":["..."]}.\n\nCV:\n${content}`,
      );
      const parsed = parseJsonObject(response);
      const title = String(parsed?.title ?? "Professional profile from CV").trim().slice(0, 120);
      const body = String(parsed?.body ?? "").trim();
      const tags = Array.isArray(parsed?.tags)
        ? parsed.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean).slice(0, 12)
        : ["career", "cv"];
      if (!title || body.length < 40) throw new Error("CV editor returned an invalid memory draft");
      return { title, body, tags };
    });
  }

  #enqueue(task) {
    const pending = this.queue.then(task);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async #run(prompt) {
    await this.gateway.request("sessions.create", {
      key: this.sessionKey,
      agentId: "main",
      label: "Hunting · CV Editor",
      model: CV_EDITOR_MODEL,
    });
    await this.gateway.request("sessions.reset", {
      key: this.sessionKey,
      agentId: "main",
      reason: "reset",
    });
    await this.gateway.request("sessions.patch", {
      key: this.sessionKey,
      agentId: "main",
      model: CV_EDITOR_MODEL,
      thinkingLevel: "medium",
    });

    const final = this.#waitForFinal();
    await this.gateway.request("chat.send", {
      sessionKey: this.sessionKey,
      agentId: "main",
      message: prompt,
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    return final;
  }

  #waitForFinal() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("CV editor timed out"));
      }, this.timeoutMs);
      const onEvent = (event, payload) => {
        if (event !== "chat" || payload?.sessionKey !== this.sessionKey) return;
        if (payload?.state === "error") {
          cleanup();
          reject(new Error(payload?.errorMessage || "CV editor failed"));
          return;
        }
        if (payload?.state !== "final") return;
        cleanup();
        resolve(messageText(payload.message));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.gateway.off("event", onEvent);
      };
      this.gateway.on("event", onEvent);
    });
  }
}

export function applyCvOperations(content, operations) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 12) {
    throw new Error("CV editor returned an invalid revision");
  }
  let revised = content;
  for (const operation of operations) {
    const type = String(operation?.type ?? "");
    if (type === "insert_after") {
      const anchor = String(operation?.anchor ?? "");
      const text = String(operation?.text ?? "");
      if (!anchor || !text) throw new Error("CV editor returned an invalid insertion");
      const { end } = uniqueRange(revised, anchor);
      revised = `${revised.slice(0, end)}${text}${revised.slice(end)}`;
      continue;
    }
    if (type !== "replace") throw new Error("CV editor returned an unsupported edit operation");
    const oldText = String(operation?.oldText ?? "");
    const newText = String(operation?.newText ?? "");
    if (!oldText || !newText || oldText === newText) {
      throw new Error("CV editor returned an invalid text replacement");
    }
    const range = uniqueRange(revised, oldText);
    revised = `${revised.slice(0, range.start)}${newText}${revised.slice(range.end)}`;
  }
  if (revised.length < 40) throw new Error("CV editor returned an invalid revision");
  return revised;
}

function uniqueRange(content, target) {
  const first = content.indexOf(target);
  if (first >= 0 && content.indexOf(target, first + target.length) < 0) {
    return { start: first, end: first + target.length };
  }
  const tokens = target.trim().split(/\s+/u).map(escapeRegExp);
  const matches = [...content.matchAll(new RegExp(tokens.join("\\s+"), "gu"))];
  if (matches.length !== 1 || matches[0].index === undefined) {
    throw new Error("CV editor could not target one exact CV passage safely");
  }
  return { start: matches[0].index, end: matches[0].index + matches[0][0].length };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseJsonObject(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? String(text);
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("CV editor returned invalid JSON");
  return JSON.parse(source.slice(start, end + 1));
}

function messageText(message) {
  if (typeof message === "string") return message;
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((item) => (typeof item === "string" ? item : item?.text ?? "")).join("");
  }
  return "";
}
