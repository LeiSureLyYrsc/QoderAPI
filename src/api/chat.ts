import crypto from "node:crypto";
import { CLIENT_PRODUCT_VERSION, urls } from "../config/endpoints.js";
import { resolveModelRoute } from "../config/routing.js";
import type {
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  ChatUsage,
  QoderCredentials,
  QoderMode,
  ToolCall,
  ToolDefinition,
} from "../types.js";
import { qoderFetch } from "./client.js";
import { getModelConfig, listModels } from "./models.js";
import { normalizeConversation } from "./messages.js";

function transformTools(tools?: ToolDefinition[]): unknown[] {
  if (!tools?.length) return [];
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.function.name,
      description: t.function.description || "",
      parameters: t.function.parameters || { type: "object", properties: {} },
    },
  }));
}

function stableHash(...parts: string[]): string {
  const h = crypto.createHash("sha256");
  for (const p of parts) {
    h.update(p);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

function buildRequestBody(
  req: ChatRequest,
  mode: QoderMode,
  creds: QoderCredentials,
  modelConfig: { key: string; is_reasoning: boolean; max_output_tokens: number; source: string }
): Record<string, unknown> {
  const normalized = normalizeConversation(req.messages);
  const systemParts = normalized.filter((m) => m.role === "system");
  const rest = normalized.filter((m) => m.role !== "system");
  const systemText = systemParts.map((m) => String(m.content || "")).join("\n");
  const messages =
    systemText.length > 0
      ? [{ role: "system", content: systemText }, ...rest]
      : rest;

  let lastUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserText = String(messages[i]!.content || "");
      break;
    }
  }

  const qoderModel = modelConfig.key;
  let maxTokens = modelConfig.max_output_tokens || 32768;
  if (req.maxTokens && req.maxTokens < maxTokens) maxTokens = req.maxTokens;

  const toolsRaw = transformTools(req.tools);
  const recordID = stableHash(
    "qoder-record",
    qoderModel,
    JSON.stringify(messages),
    JSON.stringify(toolsRaw),
    `mt=${maxTokens}`
  );
  const sessionPart = stableHash("qoder-session", creds.userID, qoderModel);
  const sessionID = `${sessionPart}-${req.sessionId || crypto.randomUUID()}`;

  return {
    request_id: crypto.randomUUID(),
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: sessionID,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    system: "",
    messages,
    tools: toolsRaw,
    parameters: { max_tokens: maxTokens },
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: {
          key: qoderModel,
          is_reasoning: modelConfig.is_reasoning,
        },
        originalContent: lastUserText,
      },
      features: [],
      text: lastUserText,
    },
    model_config: modelConfig,
    business: {
      product: "cli",
      version: CLIENT_PRODUCT_VERSION,
      type: "agent",
      stage: "start",
      id: crypto.randomUUID(),
      name: lastUserText.substring(0, 30),
      begin_at: Date.now(),
    },
  };
}

async function* parseSse(
  response: Response
): AsyncGenerator<ChatStreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  const toolState = new Map<
    number,
    { id: string; name: string; arguments: string; started: boolean }
  >();
  let finishReason = "stop";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) break;
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line.startsWith("data:")) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") {
          if (dataStr === "[DONE]") {
            // flush tools
            for (const [index, state] of toolState) {
              if (state.started) {
                yield {
                  type: "tool_call",
                  index,
                  id: state.id || `call_${index}`,
                  name: state.name || "unknown",
                  arguments: state.arguments || "{}",
                };
              }
            }
            yield { type: "finish", reason: finishReason };
          }
          continue;
        }

        try {
          let envelope: unknown = JSON.parse(dataStr);
          if (
            envelope &&
            typeof envelope === "object" &&
            "statusCodeValue" in envelope &&
            (envelope as { statusCodeValue: number }).statusCodeValue &&
            (envelope as { statusCodeValue: number }).statusCodeValue !== 200
          ) {
            yield {
              type: "error",
              error: `Upstream status ${(envelope as { statusCodeValue: number }).statusCodeValue}: ${(envelope as { body?: string }).body || ""}`,
            };
            continue;
          }

          let inner: unknown = envelope;
          if (envelope && typeof envelope === "object" && "body" in envelope) {
            const body = (envelope as { body: unknown }).body;
            if (body === "[DONE]") {
              for (const [index, state] of toolState) {
                if (state.started) {
                  yield {
                    type: "tool_call",
                    index,
                    id: state.id || `call_${index}`,
                    name: state.name || "unknown",
                    arguments: state.arguments || "{}",
                  };
                }
              }
              yield { type: "finish", reason: finishReason };
              continue;
            }
            inner = typeof body === "string" ? JSON.parse(body) : body;
          }

          if (!inner || typeof inner !== "object") continue;
          const obj = inner as {
            usage?: Record<string, unknown>;
            choices?: Array<{
              delta?: {
                content?: string | null;
                reasoning_content?: string | null;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
              message?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: ToolCall[];
              };
            }>;
          };

          if (obj.usage) {
            const u = obj.usage;
            const promptTokens = Number(u.prompt_tokens ?? 0);
            const cacheRead = Number(
              (u.prompt_tokens_details as { cached_tokens?: number } | undefined)
                ?.cached_tokens ?? 0
            );
            const cacheWrite = Number(
              (u.prompt_tokens_details as { cache_write_tokens?: number } | undefined)
                ?.cache_write_tokens ?? 0
            );
            const usage: ChatUsage = {
              prompt_tokens: promptTokens,
              completion_tokens: Number(u.completion_tokens ?? 0),
              total_tokens: Number(u.total_tokens ?? 0),
              cache_read_tokens: cacheRead,
              cache_write_tokens: cacheWrite,
            };
            yield { type: "usage", usage };
          }

          const choice = obj.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta;
          if (delta?.reasoning_content) {
            yield { type: "reasoning", text: delta.reasoning_content };
          }
          if (delta?.content) {
            yield { type: "text", text: delta.content };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let state = toolState.get(idx);
              if (!state) {
                state = { id: "", name: "", arguments: "", started: false };
                toolState.set(idx, state);
              }
              if (tc.id) state.id = tc.id;
              if (tc.function?.name) state.name = tc.function.name;
              if (tc.function?.arguments) {
                state.arguments += tc.function.arguments;
                state.started = true;
                yield {
                  type: "tool_call_delta",
                  index: idx,
                  id: state.id || undefined,
                  name: state.name || undefined,
                  arguments: tc.function.arguments,
                };
              }
            }
          }

          // non-stream message style
          if (choice.message) {
            if (choice.message.reasoning_content) {
              yield { type: "reasoning", text: choice.message.reasoning_content };
            }
            if (choice.message.content) {
              yield { type: "text", text: choice.message.content };
            }
            if (choice.message.tool_calls) {
              let index = 0;
              for (const tc of choice.message.tool_calls) {
                yield {
                  type: "tool_call",
                  index,
                  id: tc.id,
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                };
                index += 1;
              }
            }
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // ensure finish if stream ended without [DONE]
  yield { type: "finish", reason: finishReason };
}

export async function* chatStream(
  req: ChatRequest,
  options?: {
    mode?: QoderMode;
    credentials?: QoderCredentials;
    signal?: AbortSignal;
    defaultMode?: QoderMode;
    accountId?: string;
  }
): AsyncGenerator<ChatStreamEvent> {
  const {
    accountToCredentials,
    bindSession,
    classifyProviderError,
    countAvailable,
    getAccount,
    getAccountForSession,
    getSessionBind,
    reportError,
  } = await import("../auth/pool.js");
  const { ensureFreshCredentials } = await import("./client.js");

  const route = resolveModelRoute(req.model, {
    preferredMode: req.mode || options?.mode,
    defaultMode: options?.defaultMode,
    forceMode: options?.credentials?.mode,
  });
  const mode = route.mode;
  const models = await listModels({ mode, credentials: options?.credentials });
  const modelConfig = getModelConfig(route.publicId, models, mode);
  modelConfig.key = route.key;

  const sessionKey = req.sessionId;
  const tried = new Set<string>();
  const maxAttempts = options?.credentials
    ? 1
    : Math.max(1, countAvailable(route));
  let lastError = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let creds = options?.credentials;
    let accountId = options?.accountId || options?.credentials?.accountId;

    if (!creds) {
      if (options?.accountId) {
        const acc = getAccount(options.accountId);
        if (!acc) {
          yield { type: "error", error: `Account not found: ${options.accountId}` };
          yield { type: "finish", reason: "error" };
          return;
        }
        creds = accountToCredentials(acc);
        accountId = acc.id;
      } else {
        const acc = getAccountForSession(route, sessionKey, tried);
        if (!acc) {
          lastError =
            lastError ||
            `No active account for ${route.publicId}` +
              (route.mode === "global"
                ? " (Only Ultimate accounts only serve global/ultimate)"
                : "");
          break;
        }
        creds = accountToCredentials(acc);
        accountId = acc.id;
      }
    }

    if (accountId) tried.add(accountId);
    creds = await ensureFreshCredentials(creds);

    const sticky = sessionKey ? getSessionBind(sessionKey) : null;
    const upstreamSessionId =
      sticky && sticky.accountId === accountId
        ? sticky.upstreamSessionId
        : sessionKey || crypto.randomUUID();
    if (sessionKey && accountId) {
      bindSession(sessionKey, accountId, upstreamSessionId);
    }

    const body = buildRequestBody(
      { ...req, model: route.bareId, sessionId: upstreamSessionId },
      mode,
      creds,
      modelConfig
    );

    const chatURL = urls(mode).chat;
    let res: Response;
    try {
      res = await qoderFetch({
        method: "POST",
        url: chatURL,
        body,
        encode: true,
        mode,
        credentials: creds,
        signal: options?.signal,
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Accept-Encoding": "identity",
          "X-Model-Key": modelConfig.key,
          "X-Model-Source": modelConfig.source || "system",
        },
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      lastError = `Qoder chat failed: ${res.status} ${res.statusText}. ${errText.slice(0, 400)}`;
      const kind = classifyProviderError(res.status, errText);
      if (accountId && kind) reportError(accountId, kind);
      if (kind && attempt + 1 < maxAttempts) continue;
      yield { type: "error", error: lastError };
      yield { type: "finish", reason: "error" };
      return;
    }

    yield* parseSse(res);
    return;
  }

  yield {
    type: "error",
    error: lastError || `No available account for ${route.publicId}`,
  };
  yield { type: "finish", reason: "error" };
}

export async function chat(
  req: ChatRequest,
  options?: {
    mode?: QoderMode;
    credentials?: QoderCredentials;
    signal?: AbortSignal;
    defaultMode?: QoderMode;
    accountId?: string;
  }
): Promise<ChatResult> {
  let content = "";
  let reasoning = "";
  const tool_calls: ToolCall[] = [];
  let finish_reason = "stop";
  let usage: ChatUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const toolAcc = new Map<number, ToolCall>();

  for await (const ev of chatStream(req, options)) {
    switch (ev.type) {
      case "text":
        content += ev.text;
        break;
      case "reasoning":
        reasoning += ev.text;
        break;
      case "tool_call_delta": {
        let tc = toolAcc.get(ev.index);
        if (!tc) {
          tc = {
            id: ev.id || `call_${ev.index}`,
            type: "function",
            function: { name: ev.name || "", arguments: "" },
          };
          toolAcc.set(ev.index, tc);
        }
        if (ev.id) tc.id = ev.id;
        if (ev.name) tc.function.name = ev.name;
        if (ev.arguments) tc.function.arguments += ev.arguments;
        break;
      }
      case "tool_call":
        toolAcc.set(ev.index, {
          id: ev.id,
          type: "function",
          function: { name: ev.name, arguments: ev.arguments },
        });
        break;
      case "usage":
        usage = ev.usage;
        break;
      case "finish":
        finish_reason = ev.reason;
        break;
      case "error":
        throw new Error(ev.error);
    }
  }

  for (const tc of toolAcc.values()) tool_calls.push(tc);
  if (tool_calls.length > 0 && finish_reason === "stop") finish_reason = "tool_calls";

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    model: req.model,
    content,
    reasoning: reasoning || undefined,
    tool_calls,
    finish_reason,
    usage,
  };
}
