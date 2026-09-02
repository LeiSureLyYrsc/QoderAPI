import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { resolveMode } from "../config/endpoints.js";
import { chat, chatStream } from "../api/chat.js";
import { listModels } from "../api/models.js";
import type {
  ChatMessage,
  ChatRequest,
  QoderMode,
  ToolDefinition,
} from "../types.js";
import { extractSessionKey } from "../session.js";
import { conversationHasTools, summarizeMessages } from "../api/messages.js";
import { logChat } from "../log.js";
import { handleApi } from "../web/api.js";
import { tryServeStatic } from "../web/static.js";
import {
  getDefaultMode,
  getProxyApiKey,
  setDefaultMode,
  updateSettings,
} from "../web/state.js";

export interface OpenAIServerOptions {
  host?: string;
  port?: number;
  mode?: QoderMode;
  apiKey?: string;
  openBrowser?: boolean;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  const host = hostHeader.toLowerCase().split(":")[0] || "";
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

function isLoopbackBind(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function extractApiKey(req: http.IncomingMessage): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  const x = req.headers["x-api-key"];
  if (typeof x === "string") return x.trim();
  return "";
}

function toChatRequest(
  body: Record<string, unknown>,
  headers?: IncomingHttpHeaders
): ChatRequest {
  const messages = (body.messages as ChatMessage[]) || [];
  const tools = body.tools as ToolDefinition[] | undefined;
  const model = String(body.model || "cn/auto");
  return {
    model,
    messages,
    tools,
    maxTokens:
      body.max_tokens != null
        ? Number(body.max_tokens)
        : body.max_completion_tokens != null
          ? Number(body.max_completion_tokens)
          : undefined,
    stream: Boolean(body.stream),
    sessionId: extractSessionKey({ body, headers, messages, model }),
    temperature: body.temperature != null ? Number(body.temperature) : undefined,
    mode:
      typeof body.mode === "string" ? resolveMode(body.mode) : undefined,
  };
}

function openUrl(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* ignore */
  }
}

export function startOpenAIServer(options: OpenAIServerOptions = {}): http.Server {
  const host = options.host || "127.0.0.1";
  const port = options.port ?? Number(process.env.PORT || 3927);
  const loopbackOnly = isLoopbackBind(host);
  if (options.mode) setDefaultMode(resolveMode(options.mode));
  if (options.apiKey) updateSettings({ proxyApiKey: options.apiKey });

  const server = http.createServer(async (req, res) => {
    try {
      if (loopbackOnly && !isLoopbackHost(req.headers.host)) {
        return sendJson(res, 403, {
          error: { message: "Host not allowed", type: "invalid_request_error" },
        });
      }

      const origin = req.headers.origin;
      if (loopbackOnly && origin && origin !== "null") {
        try {
          const o = new URL(origin);
          if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(o.hostname)) {
            return sendJson(res, 403, {
              error: {
                message: "Cross-origin browser requests are blocked",
                type: "invalid_request_error",
              },
            });
          }
        } catch {
          return sendJson(res, 403, {
            error: { message: "Invalid Origin", type: "invalid_request_error" },
          });
        }
      }

      const url = new URL(req.url || "/", `http://${host}:${port}`);
      let path = url.pathname;
      // normalize trailing slash except root
      const pathNoTrail = path.replace(/\/+$/, "") || "/";

      // Redirect root and bare /ui (no trailing slash) → /ui/
      // Important: use raw `path`, not pathNoTrail — `/ui/` must NOT redirect again.
      if (req.method === "GET" && (path === "/" || path === "/ui")) {
        res.writeHead(302, { Location: "/ui/" });
        res.end();
        return;
      }

      // Static UI (no API key required)
      if (path === "/ui/" || path.startsWith("/ui/")) {
        if (tryServeStatic(req, res, path)) return;
      }

      // Health always open
      if (
        req.method === "GET" &&
        (pathNoTrail === "/health" || pathNoTrail === "/v1/health")
      ) {
        return sendJson(res, 200, {
          ok: true,
          dualMode: true,
          defaultMode: getDefaultMode(),
          mode: getDefaultMode(),
        });
      }

      // Management API (loopback UI) — no proxy API key required
      if (pathNoTrail === "/api" || pathNoTrail.startsWith("/api/")) {
        const handled = await handleApi(req, res, pathNoTrail, url.searchParams);
        if (handled) return;
      }

      // OpenAI-compatible routes require proxy API key when set
      const expectedKey = getProxyApiKey();
      if (expectedKey) {
        const presented = extractApiKey(req);
        if (!presented || presented !== expectedKey) {
          return sendJson(res, 401, {
            error: {
              message: "Invalid API key",
              type: "authentication_error",
              code: "invalid_api_key",
            },
          });
        }
      }

      const defaultMode = getDefaultMode();

      if (req.method === "GET" && (pathNoTrail === "/v1/models" || pathNoTrail === "/models")) {
        // Merge CN + Global catalogs; ids are prefixed (cn/..., global/...)
        const models = await listModels({ mode: "all" });
        return sendJson(res, 200, {
          object: "list",
          data: models.map((m) => ({
            id: m.id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: m.mode === "cn" ? "qoder-cn" : "qoder",
          })),
        });
      }

      if (
        req.method === "POST" &&
        (pathNoTrail === "/v1/chat/completions" ||
          pathNoTrail === "/chat/completions" ||
          pathNoTrail === "/v1/v1/chat/completions")
      ) {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const chatReq = toChatRequest(body, req.headers);
        logChat(
          `openai ${pathNoTrail} model=${chatReq.model} stream=${chatReq.stream} tools=${conversationHasTools(chatReq.messages)} ${summarizeMessages(chatReq.messages)}`
        );

        if (chatReq.stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const id = `chatcmpl-${crypto.randomUUID()}`;
          const created = Math.floor(Date.now() / 1000);
          const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: chatReq.model,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            })}\n\n`
          );

          try {
            for await (const ev of chatStream(chatReq, { defaultMode })) {
              if (ev.type === "text") {
                res.write(
                  `data: ${JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: chatReq.model,
                    choices: [
                      { index: 0, delta: { content: ev.text }, finish_reason: null },
                    ],
                  })}\n\n`
                );
              } else if (ev.type === "reasoning") {
                res.write(
                  `data: ${JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: chatReq.model,
                    choices: [
                      {
                        index: 0,
                        delta: { reasoning_content: ev.text },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`
                );
              } else if (ev.type === "tool_call_delta") {
                let st = toolAcc.get(ev.index);
                if (!st) {
                  st = {
                    id: ev.id || `call_${ev.index}`,
                    name: ev.name || "",
                    arguments: "",
                  };
                  toolAcc.set(ev.index, st);
                }
                if (ev.id) st.id = ev.id;
                if (ev.name) st.name = ev.name;
                const argDelta = ev.arguments || "";
                if (argDelta) st.arguments += argDelta;
                res.write(
                  `data: ${JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: chatReq.model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: ev.index,
                              id: st.id,
                              type: "function",
                              function: {
                                name: st.name || undefined,
                                arguments: argDelta,
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`
                );
              } else if (ev.type === "error") {
                res.write(
                  `data: ${JSON.stringify({
                    error: { message: ev.error, type: "server_error" },
                  })}\n\n`
                );
              } else if (ev.type === "finish") {
                res.write(
                  `data: ${JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: chatReq.model,
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason:
                          ev.reason === "toolUse" || ev.reason === "tool_calls"
                            ? "tool_calls"
                            : ev.reason || "stop",
                      },
                    ],
                  })}\n\n`
                );
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.write(
              `data: ${JSON.stringify({
                error: { message, type: "server_error" },
              })}\n\n`
            );
          }
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const result = await chat(chatReq, { defaultMode });
        return sendJson(res, 200, {
          id: result.id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: result.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: result.content || null,
                reasoning_content: result.reasoning,
                tool_calls: result.tool_calls.length ? result.tool_calls : undefined,
              },
              finish_reason: result.finish_reason,
            },
          ],
          usage: {
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.total_tokens,
          },
        });
      }

      return sendJson(res, 404, {
        error: { message: `Unknown route ${pathNoTrail}`, type: "invalid_request_error" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sendJson(res, 500, {
        error: { message, type: "server_error" },
      });
    }
  });

  server.listen(port, host, () => {
    const ui = `http://${host}:${port}/ui/`;
    const api = `http://${host}:${port}/v1`;
    console.log(
      `qoder-reserve listening on http://${host}:${port} (dual-mode, default=${getDefaultMode()})`
    );
    console.log(`  WebUI : ${ui}`);
    console.log(`  OpenAI: ${api}  (models: cn/... and global/...)`);
    if (options.openBrowser) openUrl(ui);
  });

  return server;
}
