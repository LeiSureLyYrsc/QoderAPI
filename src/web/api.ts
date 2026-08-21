import http from "node:http";
import fs from "node:fs";
import { login, loginToPool } from "../auth/login.js";
import { runDeviceFlow } from "../auth/device.js";
import { importOfficialCredentials } from "../auth/import-official.js";
import {
  addAccount,
  clearCredentials,
  getAccount,
  getCredentials,
  listAccounts,
  poolSummary,
  publicAccount,
  removeAccount,
  updateAccount,
  accountToCredentials,
} from "../auth/pool.js";
import { configDir, accountsFilePath } from "../auth/paths.js";
import { chat, chatStream } from "../api/chat.js";
import { extractSessionKey } from "../session.js";
import { listModels } from "../api/models.js";
import { getUsage, getUsageAll } from "../api/usage.js";
import { patSettingsUrl, resolveMode, urls } from "../config/endpoints.js";
import type {
  ChatMessage,
  ChatRequest,
  GlobalTier,
  QoderMode,
  ToolDefinition,
} from "../types.js";
import {
  createDeviceSession,
  getDefaultMode,
  getDeviceSession,
  getProxyApiKey,
  getSettings,
  patchDeviceSession,
  publicCredential,
  setDefaultMode,
  updateSettings,
} from "./state.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function requireMode(body: Record<string, unknown>, query?: string | null): QoderMode {
  const raw = query || (typeof body.mode === "string" ? body.mode : "");
  if (!raw || raw === "all") throw new Error("mode is required: cn | global");
  return resolveMode(raw);
}

function parseTier(v: unknown): GlobalTier | undefined {
  if (v == null || v === "") return undefined;
  const t = String(v).toLowerCase().replace(/-/g, "_");
  if (t === "only_ultimate" || t === "onlyultimate" || t === "non_pro") return "only_ultimate";
  return "pro";
}

function toChatRequest(
  body: Record<string, unknown>,
  headers?: http.IncomingHttpHeaders
): ChatRequest {
  const messages = (body.messages as ChatMessage[]) || [];
  const model = String(body.model || getSettings().defaultModel || "cn/auto");
  return {
    model,
    messages,
    tools: body.tools as ToolDefinition[] | undefined,
    maxTokens:
      body.max_tokens != null
        ? Number(body.max_tokens)
        : body.maxTokens != null
          ? Number(body.maxTokens)
          : undefined,
    stream: body.stream !== false,
    sessionId: extractSessionKey({ body, headers, messages, model }),
    mode:
      typeof body.mode === "string" && body.mode !== "all"
        ? resolveMode(body.mode)
        : undefined,
  };
}

/**
 * Handle /api/* routes. Returns true if handled.
 */
export async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams
): Promise<boolean> {
  if (!pathname.startsWith("/api")) return false;

  const path = pathname.replace(/\/+$/, "") || "/api";
  const method = (req.method || "GET").toUpperCase();

  try {
    // GET /api/status
    if (method === "GET" && path === "/api/status") {
      const summary = poolSummary();
      const accounts = listAccounts().map(publicAccount);
      sendJson(res, 200, {
        ok: true,
        dualMode: true,
        pool: true,
        mode: getDefaultMode(),
        defaultMode: getDefaultMode(),
        configDir: configDir(),
        proxyApiKeySet: Boolean(getProxyApiKey()),
        settings: {
          defaultModel: getSettings().defaultModel,
          theme: getSettings().theme,
          proxyApiKeySet: Boolean(getSettings().proxyApiKey),
        },
        poolSummary: summary,
        accounts,
        // legacy fields for older UI bits
        auth: {
          cn: publicCredential(getCredentials("cn")),
          global: publicCredential(getCredentials("global")),
        },
        loggedIn: {
          cn: summary.cn.active > 0,
          global: summary.global.active > 0,
        },
        endpoints: { cn: urls("cn"), global: urls("global") },
        patSettings: {
          cn: patSettingsUrl("cn"),
          global: patSettingsUrl("global"),
        },
      });
      return true;
    }

    if (method === "POST" && path === "/api/mode") {
      const body = await readJson(req);
      const mode = resolveMode(String(body.mode || "cn"));
      setDefaultMode(mode);
      sendJson(res, 200, { mode: getDefaultMode(), defaultMode: getDefaultMode() });
      return true;
    }

    // ── Account pool ─────────────────────────────────────────────
    if (method === "GET" && path === "/api/accounts") {
      sendJson(res, 200, {
        accounts: listAccounts().map(publicAccount),
        summary: poolSummary(),
      });
      return true;
    }

    if (method === "POST" && path === "/api/accounts") {
      const body = await readJson(req);
      const mode = requireMode(body);
      const pat = typeof body.pat === "string" ? body.pat.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : undefined;
      const globalTier = parseTier(body.globalTier);
      const device = body.device === true || body.method === "device";

      if (pat) {
        const acc = await loginToPool({
          mode,
          pat,
          name,
          globalTier,
          openBrowser: false,
        });
        sendJson(res, 200, { ok: true, method: "pat", account: publicAccount(acc) });
        return true;
      }

      if (device || !pat) {
        // start device session that adds to pool on success
        const session = createDeviceSession(mode);
        const sessionMeta = session as typeof session & {
          name?: string;
          globalTier?: GlobalTier;
        };
        sessionMeta.name = name;
        sessionMeta.globalTier = globalTier;
        void (async () => {
          try {
            const creds = await runDeviceFlow({
              mode,
              openBrowser: false,
              onProgress: (msg) => patchDeviceSession(session.id, { progress: msg }),
              onAuthUrl: (url) => patchDeviceSession(session.id, { loginUrl: url }),
            });
            const acc = addAccount({
              mode,
              name,
              globalTier,
              credentials: { ...creds, mode },
            });
            patchDeviceSession(session.id, {
              status: "ok",
              progress: `Added ${acc.name}`,
            });
            (session as { accountId?: string }).accountId = acc.id;
          } catch (err) {
            patchDeviceSession(session.id, {
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        sendJson(res, 200, {
          ok: true,
          method: "device",
          sessionId: session.id,
          status: "pending",
          mode,
        });
        return true;
      }

      sendJson(res, 400, { error: "pat or device login required" });
      return true;
    }

    // PATCH /api/accounts/:id
    if (method === "PATCH" && path.startsWith("/api/accounts/")) {
      const id = path.slice("/api/accounts/".length).split("/")[0] || "";
      if (!id || id.includes("/")) {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      const body = await readJson(req);
      const patch: Parameters<typeof updateAccount>[1] = {};
      if (typeof body.name === "string") patch.name = body.name.trim();
      if (body.globalTier != null) patch.globalTier = parseTier(body.globalTier);
      if (typeof body.status === "string") {
        const s = body.status;
        if (["active", "disabled", "exhausted", "rate_limited"].includes(s)) {
          patch.status = s as "active" | "disabled" | "exhausted" | "rate_limited";
          if (s === "active") patch.rateLimitUntil = null;
        }
      }
      const acc = updateAccount(id, patch);
      if (!acc) {
        sendJson(res, 404, { error: "account not found" });
        return true;
      }
      sendJson(res, 200, { ok: true, account: publicAccount(acc) });
      return true;
    }

    // DELETE /api/accounts/:id
    if (method === "DELETE" && path.startsWith("/api/accounts/")) {
      const id = path.slice("/api/accounts/".length);
      if (!removeAccount(id)) {
        sendJson(res, 404, { error: "account not found" });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    // GET /api/accounts/export?mask=true
    if (method === "GET" && path === "/api/accounts/export") {
      const mask = searchParams.get("mask") === "true" || searchParams.get("mask") === "1";
      const raw = JSON.parse(fs.readFileSync(accountsFilePath(), "utf8")) as Record<string, unknown>[];
      if (mask) {
        for (const a of raw) {
          if (a.access) a.access = (String(a.access)).slice(0, 4) + "***";
          if (a.refresh) a.refresh = "***";
          if (a.pat) a.pat = (String(a.pat)).slice(0, 6) + "***";
        }
      }
      sendJson(res, 200, { accounts: raw, count: raw.length, masked: mask });
      return true;
    }

    // POST /api/accounts/import (JSON file body)
    if (method === "POST" && path === "/api/accounts/import") {
      const body = await readJson(req);
      const entries = Array.isArray(body.accounts) ? body.accounts : Array.isArray(body) ? body : null;
      if (!entries || !entries.length) {
        sendJson(res, 400, { error: "body must be { accounts: [...] } or a JSON array" });
        return true;
      }
      const existing = new Set(listAccounts().map((a) => a.id));
      const merged: Record<string, unknown>[] = [];
      let skipped = 0;
      for (const entry of entries as Record<string, unknown>[]) {
        const id = String(entry.id || "");
        if (id && existing.has(id)) { skipped++; continue; }
        merged.push(entry);
      }
      if (!merged.length) {
        sendJson(res, 400, { error: `No new accounts (${skipped} duplicates)` });
        return true;
      }
      const current = JSON.parse(fs.readFileSync(accountsFilePath(), "utf8")) as object[];
      current.push(...merged);
      fs.writeFileSync(accountsFilePath(), JSON.stringify(current, null, 2), { encoding: "utf8", mode: 0o600 });
      sendJson(res, 200, { ok: true, imported: merged.length, skipped, total: current.length });
      return true;
    }

    // POST /api/accounts/import (official credentials)
    if (method === "POST" && path === "/api/accounts/import") {
      const body = await readJson(req);
      const mode = requireMode(body);
      const result = await importOfficialCredentials(mode);
      if (!result.ok || !result.credentials) {
        sendJson(res, 400, { ok: false, error: result.error || "Import failed" });
        return true;
      }
      const acc = addAccount({
        mode,
        name: typeof body.name === "string" ? body.name : undefined,
        globalTier: parseTier(body.globalTier),
        credentials: result.credentials,
      });
      sendJson(res, 200, {
        ok: true,
        method: result.method,
        account: publicAccount(acc),
      });
      return true;
    }

    // POST /api/accounts/:id/refresh-pat
    if (method === "POST" && /^\/api\/accounts\/[^/]+\/refresh-pat$/.test(path)) {
      const id = path.split("/")[3] || "";
      const body = await readJson(req);
      const acc = getAccount(id);
      if (!acc) {
        sendJson(res, 404, { error: "account not found" });
        return true;
      }
      const pat =
        (typeof body.pat === "string" && body.pat.trim()) || acc.pat || "";
      if (!pat) {
        sendJson(res, 400, { error: "pat required" });
        return true;
      }
      const creds = await login({
        mode: acc.mode,
        pat,
        addToPool: false,
        openBrowser: false,
      });
      const updated = updateAccount(id, {
        ...{
          access: creds.access,
          refresh: creds.refresh,
          expires: creds.expires,
          userID: creds.userID,
          email: creds.email,
          profileName: creds.name,
          machineID: creds.machineID,
          pat: creds.pat || pat,
        },
        status: "active",
        rateLimitUntil: null,
      });
      sendJson(res, 200, { ok: true, account: updated ? publicAccount(updated) : null });
      return true;
    }

    // Legacy auth endpoints → pool add
    if (method === "POST" && path === "/api/auth/login") {
      const body = await readJson(req);
      const mode = requireMode(body);
      const pat = typeof body.pat === "string" ? body.pat.trim() : "";
      const globalTier = parseTier(body.globalTier);
      const name = typeof body.name === "string" ? body.name : undefined;

      if (pat) {
        const acc = await loginToPool({
          mode,
          pat,
          name,
          globalTier,
          openBrowser: false,
        });
        sendJson(res, 200, {
          ok: true,
          method: "pat",
          mode,
          account: publicAccount(acc),
          auth: publicCredential(accountToCredentials(acc)),
        });
        return true;
      }

      const session = createDeviceSession(mode);
      void (async () => {
        try {
          const creds = await runDeviceFlow({
            mode,
            openBrowser: false,
            onProgress: (msg) => patchDeviceSession(session.id, { progress: msg }),
            onAuthUrl: (url) => patchDeviceSession(session.id, { loginUrl: url }),
          });
          const acc = addAccount({ mode, name, globalTier, credentials: creds });
          patchDeviceSession(session.id, {
            status: "ok",
            progress: `Added ${acc.name}`,
          });
          (session as { accountId?: string }).accountId = acc.id;
        } catch (err) {
          patchDeviceSession(session.id, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      sendJson(res, 200, {
        ok: true,
        method: "device",
        sessionId: session.id,
        status: "pending",
        mode,
      });
      return true;
    }

    if (method === "GET" && path.startsWith("/api/auth/device/")) {
      const id = path.slice("/api/auth/device/".length);
      const session = getDeviceSession(id);
      if (!session) {
        sendJson(res, 404, { error: "session not found" });
        return true;
      }
      const accountId = (session as { accountId?: string }).accountId;
      const acc = accountId ? getAccount(accountId) : null;
      sendJson(res, 200, {
        id: session.id,
        mode: session.mode,
        status: session.status,
        loginUrl: session.loginUrl,
        progress: session.progress,
        error: session.error,
        account: acc ? publicAccount(acc) : null,
        auth: acc ? publicCredential(accountToCredentials(acc)) : null,
      });
      return true;
    }

    if (method === "POST" && path === "/api/auth/import") {
      const body = await readJson(req);
      const mode = requireMode(body);
      const result = await importOfficialCredentials(mode);
      if (!result.ok || !result.credentials) {
        sendJson(res, 400, { ok: false, error: result.error || "Import failed" });
        return true;
      }
      const acc = addAccount({
        mode,
        name: typeof body.name === "string" ? body.name : undefined,
        globalTier: parseTier(body.globalTier),
        credentials: result.credentials,
      });
      sendJson(res, 200, {
        ok: true,
        method: result.method,
        mode,
        account: publicAccount(acc),
        auth: publicCredential(accountToCredentials(acc)),
      });
      return true;
    }

    if (method === "POST" && path === "/api/auth/logout") {
      const body = await readJson(req);
      if (body.all === true) {
        clearCredentials();
      } else if (typeof body.id === "string") {
        removeAccount(body.id);
      } else {
        const mode = requireMode(body);
        clearCredentials(mode);
      }
      sendJson(res, 200, { ok: true, summary: poolSummary() });
      return true;
    }

    if (method === "GET" && path === "/api/models") {
      const q = searchParams.get("mode") || "all";
      const models = await listModels({ mode: q });
      sendJson(res, 200, { mode: q, defaultMode: getDefaultMode(), models });
      return true;
    }

    if (method === "GET" && path === "/api/usage") {
      const q = searchParams.get("mode") || "all";
      if (q === "all" || q === "both" || q === "*") {
        const both = await getUsageAll();
        sendJson(res, 200, { mode: "all", ...both });
        return true;
      }
      const mode = resolveMode(q);
      const usage = await getUsage({ mode });
      sendJson(res, 200, { mode, ...usage });
      return true;
    }

    if (method === "GET" && path === "/api/settings") {
      const s = getSettings();
      sendJson(res, 200, {
        defaultModel: s.defaultModel,
        theme: s.theme,
        proxyApiKeySet: Boolean(s.proxyApiKey),
        proxyApiKeyMasked: s.proxyApiKey
          ? `${s.proxyApiKey.slice(0, 2)}***${s.proxyApiKey.slice(-2)}`
          : "",
        mode: getDefaultMode(),
        defaultMode: getDefaultMode(),
      });
      return true;
    }

    if (method === "PUT" && path === "/api/settings") {
      const body = await readJson(req);
      const patch: Parameters<typeof updateSettings>[0] = {};
      if (typeof body.defaultModel === "string") patch.defaultModel = body.defaultModel;
      if (body.theme === "dark" || body.theme === "light") patch.theme = body.theme;
      if (typeof body.proxyApiKey === "string") patch.proxyApiKey = body.proxyApiKey;
      if (typeof body.mode === "string" || typeof body.defaultMode === "string") {
        setDefaultMode(resolveMode(String(body.defaultMode || body.mode)));
      }
      const s = updateSettings(patch);
      sendJson(res, 200, {
        defaultModel: s.defaultModel,
        theme: s.theme,
        proxyApiKeySet: Boolean(s.proxyApiKey),
        mode: getDefaultMode(),
        defaultMode: getDefaultMode(),
      });
      return true;
    }

    if (method === "POST" && path === "/api/chat") {
      const body = await readJson(req);
      const chatReq = toChatRequest(body, req.headers);
      const stream = body.stream !== false;
      const defaultMode = getDefaultMode();
      const accountId =
        typeof body.accountId === "string" ? body.accountId : undefined;

      if (!chatReq.messages?.length) {
        sendJson(res, 400, { error: "messages required" });
        return true;
      }

      if (!stream) {
        const result = await chat(chatReq, { defaultMode, accountId });
        sendJson(res, 200, result);
        return true;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const writeEvent = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      try {
        for await (const ev of chatStream(chatReq, { defaultMode, accountId })) {
          writeEvent(ev.type, ev);
          if (ev.type === "finish" || ev.type === "error") break;
        }
      } catch (err) {
        writeEvent("error", {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        writeEvent("finish", { type: "finish", reason: "error" });
      }
      res.end();
      return true;
    }

    sendJson(res, 404, { error: `Unknown API route ${path}` });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    const status =
      lower.includes("not logged in") ||
      lower.includes("no active account") ||
      lower.includes("no available account") ||
      lower.includes("mode is required") ||
      lower.includes("messages required") ||
      lower.includes("invalid personal token") ||
      lower.includes("account not found")
        ? 400
        : 500;
    sendJson(res, status, { error: message });
    return true;
  }
}
