import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { ChatMessage } from "./types.js";

const MAX_SESSION_KEY_LEN = 128;

function headerValue(
  headers: IncomingHttpHeaders | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return typeof v === "string" ? v : undefined;
}

function contentPreview(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (p?.type === "text") return p.text || "";
      return "";
    })
    .join("");
}

function nestedString(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function normalizeSessionKey(raw: string): string {
  return raw.trim().slice(0, MAX_SESSION_KEY_LEN);
}

/**
 * Stable session key for account stickiness.
 * Prefers explicit client ids, then falls back to model + first prompt hash.
 */
export function extractSessionKey(opts: {
  body: Record<string, unknown>;
  headers?: IncomingHttpHeaders;
  messages?: ChatMessage[];
  model?: string;
}): string {
  const { body, headers } = opts;
  const direct =
    nestedString(body, ["session_id", "sessionId"]) ||
    nestedString(body.metadata, [
      "session_id",
      "sessionId",
      "opencode_session",
      "conversation_id",
      "conversationId",
    ]) ||
    headerValue(headers, "x-session-id") ||
    headerValue(headers, "x-opencode-session") ||
    headerValue(headers, "x-conversation-id") ||
    (typeof body.user === "string" && body.user.trim()
      ? `user:${body.user}`
      : undefined);
  if (direct) return normalizeSessionKey(direct);

  const model = opts.model || String(body.model || "");
  const messages =
    opts.messages ||
    (Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : []);
  const first = messages.find((m) => m.role === "system" || m.role === "user");
  const text = first ? contentPreview(first.content).slice(0, 2000) : "";
  const hash = crypto
    .createHash("sha256")
    .update(model)
    .update("\0")
    .update(text)
    .digest("hex")
    .slice(0, 24);
  return `auto:${hash}`;
}
