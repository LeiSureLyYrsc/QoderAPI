import type { ChatMessage, ToolCall } from "../types.js";

export type UpstreamMessage = {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
};

type LoosePart = {
  type?: string;
  text?: string;
  image_url?: { url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  tool_use_id?: string;
  tool_call_id?: string;
  toolCallId?: string;
  content?: unknown;
};

type LooseMessage = ChatMessage & {
  toolCallId?: string;
  tool_use_id?: string;
  function_call?: { name?: string; arguments?: string | object };
  tool_calls?: ToolCall[] | Array<Record<string, unknown>>;
};

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const rec = p as LoosePart;
          if (rec.type === "text") return rec.text || "";
          if (typeof rec.text === "string") return rec.text;
          if (rec.content != null) return asText(rec.content);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function stringifyArgs(value: unknown): string {
  if (value == null) return "{}";
  if (typeof value === "string") return value || "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function toolCallIdOf(m: LooseMessage | LoosePart): string | undefined {
  const rec = m as Record<string, unknown>;
  const id =
    rec.tool_call_id ||
    rec.toolCallId ||
    rec.tool_use_id ||
    rec.toolUseId ||
    rec.id;
  return typeof id === "string" && id.trim() ? String(id) : undefined;
}

function toToolCall(raw: unknown, index: number): ToolCall | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const fn =
    rec.function && typeof rec.function === "object"
      ? (rec.function as Record<string, unknown>)
      : rec;
  const name = String(fn.name || rec.name || "unknown");
  const args = stringifyArgs(fn.arguments ?? rec.arguments ?? rec.input);
  const id = String(rec.id || fn.id || `call_${index}`);
  return {
    id,
    type: "function",
    function: { name, arguments: args },
  };
}

function expandOne(m: LooseMessage): UpstreamMessage[] {
  const rawRole = String(m.role || "user");
  const role = rawRole === "function" ? "tool" : rawRole;
  const parts = Array.isArray(m.content) ? (m.content as LoosePart[]) : null;
  const toolCalls: ToolCall[] = [];
  const toolResults: UpstreamMessage[] = [];
  const texts: string[] = [];

  if (parts) {
    let idx = 0;
    for (const p of parts) {
      if (typeof p === "string") {
        texts.push(p);
        continue;
      }
      const type = String(p?.type || "");
      if (type === "text") {
        if (p.text) texts.push(p.text);
      } else if (type === "image_url") {
        texts.push(`[image:${p.image_url?.url || ""}]`);
      } else if (type === "tool_use" || type === "function") {
        const tc = toToolCall(
          {
            id: p.id,
            name: p.name,
            arguments: p.arguments ?? p.input,
            function: { name: p.name, arguments: p.arguments ?? p.input },
          },
          idx++
        );
        if (tc) toolCalls.push(tc);
      } else if (type === "tool_result" || type === "tool") {
        toolResults.push({
          role: "tool",
          tool_call_id: toolCallIdOf(p) || p.tool_use_id || p.tool_call_id,
          content: asText(p.content ?? p.text),
        });
      } else if (p?.text) {
        texts.push(p.text);
      }
    }
  } else if (typeof m.content === "string") {
    texts.push(m.content);
  } else if (m.content != null) {
    texts.push(asText(m.content));
  }

  if (Array.isArray(m.tool_calls)) {
    let idx = toolCalls.length;
    for (const raw of m.tool_calls) {
      const tc = toToolCall(raw, idx++);
      if (tc) toolCalls.push(tc);
    }
  }
  if (m.function_call) {
    const tc = toToolCall(
      {
        id: (m as { id?: string }).id,
        name: m.function_call.name,
        arguments: m.function_call.arguments,
      },
      toolCalls.length
    );
    if (tc) toolCalls.push(tc);
  }

  const text = texts.filter(Boolean).join("\n");
  const out: UpstreamMessage[] = [];

  if (role === "tool") {
    if (toolResults.length) return toolResults;
    out.push({
      role: "tool",
      tool_call_id: toolCallIdOf(m),
      content: text,
      name: m.name,
    });
    return out;
  }

  if (role === "user" && toolResults.length && !text && !toolCalls.length) {
    return toolResults;
  }

  if (role === "assistant") {
    const msg: UpstreamMessage = {
      role: "assistant",
      content: text || null,
    };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    out.push(msg);
    out.push(...toolResults);
    return out;
  }

  if (text || (!toolResults.length && !toolCalls.length)) {
    out.push({ role, content: text, name: m.name });
  }
  if (toolCalls.length) {
    out.push({
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    });
  }
  out.push(...toolResults);
  return out;
}

function lastAssistant(out: UpstreamMessage[]): UpstreamMessage | undefined {
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.role === "assistant") return out[i];
  }
  return undefined;
}

function repairToolSequence(messages: UpstreamMessage[]): UpstreamMessage[] {
  const out: UpstreamMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const cur = messages[i]!;
    if (cur.role !== "tool") {
      out.push(cur);
      i += 1;
      continue;
    }

    const group: UpstreamMessage[] = [];
    while (i < messages.length && messages[i]!.role === "tool") {
      group.push(messages[i]!);
      i += 1;
    }

    const prev = lastAssistant(out);
    const prevIds = new Set((prev?.tool_calls || []).map((tc) => tc.id));
    for (const item of group) {
      if (!item.tool_call_id) {
        item.tool_call_id = `call_synth_${out.length}_${group.indexOf(item)}`;
      }
    }

    const missing = group.filter((g) => !prevIds.has(String(g.tool_call_id)));
    const needsSynth = !prev || missing.length === group.length;

    if (needsSynth) {
      out.push({
        role: "assistant",
        content: null,
        tool_calls: group.map((g, idx) => ({
          id: String(g.tool_call_id || `call_synth_${idx}`),
          type: "function" as const,
          function: { name: g.name || "unknown", arguments: "{}" },
        })),
      });
    } else if (missing.length && prev) {
      prev.tool_calls = [
        ...(prev.tool_calls || []),
        ...missing.map((g, idx) => ({
          id: String(g.tool_call_id || `call_synth_${idx}`),
          type: "function" as const,
          function: { name: g.name || "unknown", arguments: "{}" },
        })),
      ];
    }

    for (const g of group) {
      out.push({
        role: "tool",
        tool_call_id: g.tool_call_id,
        content: g.content ?? "",
        name: g.name,
      });
    }
  }
  return out;
}

export function contentToText(content: ChatMessage["content"]): string {
  return asText(content);
}

/** Expand Anthropic/OpenAI tool payloads and repair orphan tool results. */
export function normalizeConversation(messages: ChatMessage[]): UpstreamMessage[] {
  const expanded: UpstreamMessage[] = [];
  for (const m of messages || []) {
    expanded.push(...expandOne(m as LooseMessage));
  }
  return repairToolSequence(expanded);
}
