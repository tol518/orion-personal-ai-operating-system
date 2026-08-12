import { randomUUID } from "node:crypto";

export const LUNA_MODEL = "openai/gpt-5.6-luna";
export const LUNA_CONTEXT_WINDOW = 1_050_000;
const INTERNAL_SESSION_KEY = "agent:codex:dashboard:neural-memory-engine";
const RELATION_TYPES = new Set([
  "related",
  "similar_to",
  "supports",
  "contradicts",
  "caused_by",
  "derived_from",
  "part_of",
  "same_project",
  "same_entity",
  "temporal",
  "unrelated",
]);

function messageText(message) {
  if (typeof message === "string") return message;
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((item) => typeof item === "string" ? item : item?.text ?? "").join("");
  }
  return "";
}

function jsonFromText(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  return JSON.parse(candidate.trim());
}

export class OAuthLunaRunner {
  constructor({ gateway, timeoutMs = 90_000 } = {}) {
    this.gateway = gateway;
    this.timeoutMs = timeoutMs;
    this.sessionKey = INTERNAL_SESSION_KEY;
    this.effectiveContextWindow = null;
    this.queue = Promise.resolve();
  }

  ownsSession(sessionKey) {
    return sessionKey === this.sessionKey;
  }

  run(prompt) {
    const pending = this.queue.then(() => this.#run(prompt));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async #run(prompt) {
    await this.gateway.request("sessions.create", {
      key: this.sessionKey,
      agentId: "codex",
      label: "Neural Memory Engine · Luna",
      model: LUNA_MODEL,
    });
    await this.gateway.request("sessions.reset", {
      key: this.sessionKey,
      agentId: "codex",
      reason: "reset",
    });
    await this.gateway.request("sessions.patch", {
      key: this.sessionKey,
      agentId: "codex",
      model: LUNA_MODEL,
      thinkingLevel: "low",
    });

    const final = this.#waitForFinal();
    await this.gateway.request("chat.send", {
      sessionKey: this.sessionKey,
      agentId: "codex",
      message: prompt,
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    const text = await final;
    const listed = await this.gateway.request("sessions.list", {
      limit: 5,
      label: "Neural Memory Engine · Luna",
      agentId: "codex",
    }).catch(() => null);
    const session = listed?.sessions?.find((entry) => entry.key === this.sessionKey);
    if (Number.isFinite(Number(session?.contextTokens))) {
      this.effectiveContextWindow = Number(session.contextTokens);
    }
    return text;
  }

  #waitForFinal() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("GPT-5.6 Luna classification timed out"));
      }, this.timeoutMs);
      const onEvent = (event, payload) => {
        if (event !== "chat" || payload?.sessionKey !== this.sessionKey) return;
        if (payload?.state === "error") {
          cleanup();
          reject(new Error(payload?.errorMessage || "GPT-5.6 Luna classification failed"));
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

export class RelationClassifier {
  constructor({ runner }) {
    this.runner = runner;
  }

  async classify(source, candidates) {
    if (!candidates.length) return [];
    const payload = candidates.map(({ memory, score, factors }) => ({
      targetId: memory.id,
      title: memory.title,
      body: memory.body.slice(0, 5_000),
      tags: memory.tags,
      preScore: score,
      factors,
    }));
    const response = await this.runner.run(
      `You are the relationship classifier for an Obsidian second-brain graph.\n` +
      `Classify only genuine relationships from the source memory to each candidate.\n` +
      `Allowed relationType values: related, similar_to, supports, contradicts, caused_by, derived_from, part_of, same_project, same_entity, temporal, unrelated.\n` +
      `Use related when the source explicitly names or describes an association with a person, organization, or place and no narrower relation type fits.\n` +
      `Return only a JSON array. Each item: {"targetId":"...","relationType":"...","confidence":0..1,"sourceSupersedesTarget":boolean,"reason":"short"}.\n` +
      `Set sourceSupersedesTarget only when the source is newer and clearly replaces a contradictory target.\n\n` +
      `SOURCE:\n${JSON.stringify({ id: source.id, title: source.title, body: source.body.slice(0, 7_500), tags: source.tags })}\n\n` +
      `CANDIDATES:\n${JSON.stringify(payload)}`,
    );
    const parsed = jsonFromText(response);
    if (!Array.isArray(parsed)) throw new Error("GPT-5.6 Luna returned invalid relationship JSON");
    const allowedIds = new Set(candidates.map(({ memory }) => memory.id));
    return parsed.flatMap((item) => {
      const targetId = String(item?.targetId ?? "").trim();
      const relationType = String(item?.relationType ?? "").trim();
      const confidence = Number(item?.confidence);
      if (!allowedIds.has(targetId) || !RELATION_TYPES.has(relationType) || !Number.isFinite(confidence)) return [];
      return [{
        targetId,
        relationType,
        confidence: Math.max(0, Math.min(1, confidence)),
        sourceSupersedesTarget: item?.sourceSupersedesTarget === true,
        reason: String(item?.reason ?? "").trim().slice(0, 240),
      }];
    });
  }
}
