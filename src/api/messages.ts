import type { ChatMessage, ToolCall } from "../types.js";

export type UpstreamMessage = {
  role: string;
  content: string;
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
  toolName?: string;
  input?: unknown;
  arguments?: unknown;
  output?: unknown;
  result?: unknown;
  value?: unknown;
  tool_use_id?: string;
  tool_call_id?: string;
  toolCallId?: string;
  toolUseId?: string;
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
          const type = String(rec.type || "").replace(/_/g, "-");
          if (type === "text" || type === "reasoning" || type === "thinking") {
            return rec.text || "";
          }
          if (typeof rec.text === "string") return rec.text;
          if (rec.output != null) return asText(rec.output);
          if (rec.result != null) return asText(rec.result);
          if (rec.content != null) return asText(rec.content);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.output === "string") return rec.output;
    if (typeof rec.text === "string") return rec.text;
    if (rec.value != null) return asText(rec.value);
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

function partType(p: LoosePart | string | undefined): string {
  if (!p || typeof p === "string") return "";
  return String(p.type || "")
    .trim()
    .replace(/_/g, "-")
    .toLowerCase();
}

function toolCallIdOf(m: LooseMessage | LoosePart): string | undefined {
  const rec = m as Record<string, unknown>;
  const id =
    rec.toolCallId ||
    rec.tool_call_id ||
    rec.tool_use_id ||
    rec.toolUseId ||
    rec.id;
  return typeof id === "string" && id.trim() ? String(id) : undefined;
}

function toolResultText(p: LoosePart): string {
  if (p.output != null) return asText(p.output);
  if (p.result != null) return asText(p.result);
  if (p.value != null) return asText(p.value);
  if (p.content != null) return asText(p.content);
  if (p.text) return p.text;
  return "";
}

function toToolCall(raw: unknown, index: number): ToolCall | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const fn =
    rec.function && typeof rec.function === "object"
      ? (rec.function as Record<string, unknown>)
      : rec;
  const name = String(fn.name || rec.name || rec.toolName || "unknown");
  const args = stringifyArgs(fn.arguments ?? rec.arguments ?? rec.input);
  const id = String(
    rec.toolCallId || rec.tool_call_id || rec.id || fn.id || `call_${index}`
  );
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
      const type = partType(p);
      if (type === "text" || type === "reasoning" || type === "thinking") {
        if (p.text) texts.push(p.text);
      } else if (type === "image-url" || type === "image_url") {
        texts.push(`[image:${p.image_url?.url || ""}]`);
      } else if (
        type === "tool-use" ||
        type === "tool-call" ||
        type === "function"
      ) {
        const tc = toToolCall(
          {
            id: p.id,
            toolCallId: p.toolCallId,
            tool_call_id: p.tool_call_id,
            name: p.name || p.toolName,
            arguments: p.arguments ?? p.input,
            function: {
              name: p.name || p.toolName,
              arguments: p.arguments ?? p.input,
            },
          },
          idx++
        );
        if (tc) toolCalls.push(tc);
      } else if (type === "tool-result" || type === "tool") {
        toolResults.push({
          role: "tool",
          tool_call_id: toolCallIdOf(p),
          content: toolResultText(p),
          name: p.name || p.toolName,
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
      content: text,
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
      content: "",
      tool_calls: toolCalls,
    });
  }
  out.push(...toolResults);
  return out;
}

function immediatelyPrecedingAssistant(
  out: UpstreamMessage[]
): UpstreamMessage | undefined {
  const prev = out[out.length - 1];
  return prev?.role === "assistant" ? prev : undefined;
}

function synthToolCalls(group: UpstreamMessage[]): ToolCall[] {
  return group.map((g, idx) => ({
    id: String(g.tool_call_id || `call_synth_${idx}`),
    type: "function" as const,
    function: { name: g.name || "unknown", arguments: "{}" },
  }));
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

    for (const item of group) {
      if (!item.tool_call_id) {
        item.tool_call_id = `call_synth_${out.length}_${group.indexOf(item)}`;
      }
    }

    const prev = immediatelyPrecedingAssistant(out);
    const prevIds = new Set((prev?.tool_calls || []).map((tc) => tc.id));
    const adjacentWithCalls = Boolean(prev?.tool_calls?.length);
    const missing = group.filter((g) => !prevIds.has(String(g.tool_call_id)));

    if (!adjacentWithCalls) {
      out.push({
        role: "assistant",
        content: "",
        tool_calls: synthToolCalls(group),
      });
    } else if (missing.length && prev) {
      prev.tool_calls = [...(prev.tool_calls || []), ...synthToolCalls(missing)];
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

function assertToolFollowsCalls(messages: UpstreamMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role !== "tool") continue;
    const prev = messages[i - 1];
    if (!prev || prev.role !== "assistant" || !prev.tool_calls?.length) {
      throw new Error("internal: tool message is not adjacent to assistant tool_calls");
    }
  }
}

export function summarizeMessages(
  messages: Array<{
    role?: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
  }>
): string {
  return messages
    .map((m, i) => {
      const ids = (m.tool_calls || [])
        .map((tc) => tc.id || tc.function?.name || "?")
        .join(",");
      const parts = Array.isArray(m.content)
        ? (m.content as Array<{ type?: string }>)
            .map((p) => p?.type || "part")
            .slice(0, 6)
            .join("+")
        : typeof m.content === "string"
          ? `text:${Math.min(m.content.length, 9999)}`
          : m.content == null
            ? "empty"
            : typeof m.content;
      const extra = [
        ids ? `calls=${ids}` : "",
        m.tool_call_id ? `tid=${m.tool_call_id}` : "",
        parts ? `c=${parts}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `${i}:${m.role || "?"}${extra ? `{${extra}}` : ""}`;
    })
    .join(" -> ");
}

export function conversationHasTools(
  messages: Array<{ role?: string; tool_calls?: unknown; content?: unknown }>
): boolean {
  return (messages || []).some((m) => {
    if (m.role === "tool" || m.role === "function") return true;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
    if (Array.isArray(m.content)) {
      return (m.content as Array<{ type?: string }>).some((p) => {
        const t = String(p?.type || "").replace(/_/g, "-");
        return t === "tool-call" || t === "tool-use" || t === "tool-result" || t === "tool";
      });
    }
    return false;
  });
}

/** Expand Anthropic/OpenAI/OpenCode tool payloads and repair orphan tool results. */
export function normalizeConversation(messages: ChatMessage[]): UpstreamMessage[] {
  const expanded: UpstreamMessage[] = [];
  for (const m of messages || []) {
    expanded.push(...expandOne(m as LooseMessage));
  }
  const repaired = repairToolSequence(expanded);
  assertToolFollowsCalls(repaired);
  return repaired;
}
