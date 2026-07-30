import {
  COSY_CLIENT_TYPE,
  COSY_VERSION,
  USER_AGENT,
  resolveMode,
} from "../config/endpoints.js";
import { buildAuthHeaders } from "../crypto/cosy.js";
import { qoderEncodeBody } from "../crypto/encode.js";
import { ensureFresh } from "../auth/refresh.js";
import {
  accountToCredentials,
  getAccount,
  getCredentials,
  getNextAvailable,
  saveCredentials,
  updateAccount,
} from "../auth/pool.js";
import { resolveModelRoute } from "../config/routing.js";
import type { QoderCredentials, QoderMode } from "../types.js";

export class QoderHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, statusText: string, body: string) {
    super(`HTTP ${status} ${statusText}: ${body.slice(0, 400)}`);
    this.name = "QoderHttpError";
    this.status = status;
    this.body = body;
  }
}

export interface RequestOptions {
  method?: string;
  url: string;
  body?: unknown;
  /** When true, body is COSY-signed and Encode=1 obfuscated. */
  encode?: boolean;
  /** Use plain Bearer access token (OpenAPI) instead of COSY. */
  bearer?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  credentials?: QoderCredentials;
  mode?: QoderMode;
}

export async function ensureFreshCredentials(
  credentials: QoderCredentials
): Promise<QoderCredentials> {
  const fresh = await ensureFresh(credentials);
  if (fresh.accountId) {
    updateAccount(fresh.accountId, {
      access: fresh.access,
      refresh: fresh.refresh,
      expires: fresh.expires,
      userID: fresh.userID,
      email: fresh.email,
      profileName: fresh.name,
      machineID: fresh.machineID,
      pat: fresh.pat,
    });
  } else if (fresh !== credentials) {
    saveCredentials(fresh);
  }
  return fresh;
}

/**
 * Resolve credentials for a mode (pool: next available, or legacy first active).
 */
export async function resolveCredentials(
  mode?: QoderMode,
  explicit?: QoderCredentials | null
): Promise<QoderCredentials> {
  if (explicit) {
    return ensureFreshCredentials(explicit);
  }
  const m = resolveMode(mode);
  const route = resolveModelRoute(m === "cn" ? "cn/auto" : "global/auto", {
    forceMode: m,
  });
  const acc = getNextAvailable(route);
  if (acc) {
    return ensureFreshCredentials(accountToCredentials(acc));
  }
  const stored = getCredentials(m);
  if (!stored) {
    throw new Error(
      `Not logged in for mode=${m}. Add an account: WebUI 账号号池 or qoder-reserve accounts add --mode ${m}`
    );
  }
  return ensureFreshCredentials(stored);
}

export async function resolveCredentialsForModel(
  modelId: string,
  options?: { defaultMode?: QoderMode; accountId?: string }
): Promise<{ credentials: QoderCredentials; mode: QoderMode }> {
  if (options?.accountId) {
    const acc = getAccount(options.accountId);
    if (!acc) throw new Error(`Account not found: ${options.accountId}`);
    return {
      credentials: await ensureFreshCredentials(accountToCredentials(acc)),
      mode: acc.mode,
    };
  }
  const route = resolveModelRoute(modelId, { defaultMode: options?.defaultMode });
  const acc = getNextAvailable(route);
  if (!acc) {
    throw new Error(
      `No active account for ${route.publicId}` +
        (route.mode === "global"
          ? " (Only Ultimate accounts only serve global/ultimate)"
          : "")
    );
  }
  return {
    credentials: await ensureFreshCredentials(accountToCredentials(acc)),
    mode: route.mode,
  };
}

export async function qoderFetch(opts: RequestOptions): Promise<Response> {
  const creds = await resolveCredentials(opts.mode, opts.credentials);
  const method = (opts.method || "GET").toUpperCase();
  let bodyBytes: Buffer | undefined;
  let rawBodyForSign: Buffer | undefined;

  if (opts.body !== undefined && opts.body !== null) {
    const json =
      typeof opts.body === "string" || Buffer.isBuffer(opts.body)
        ? Buffer.isBuffer(opts.body)
          ? opts.body
          : Buffer.from(opts.body)
        : Buffer.from(JSON.stringify(opts.body));
    if (opts.encode) {
      const encoded = qoderEncodeBody(json);
      bodyBytes = Buffer.from(encoded, "utf8");
      rawBodyForSign = bodyBytes;
    } else {
      bodyBytes = json;
      rawBodyForSign = json;
    }
  }

  const headers: Record<string, string> = {
    Accept: opts.headers?.Accept || "application/json",
    "User-Agent": USER_AGENT,
    "Cosy-Version": COSY_VERSION,
    "Cosy-ClientType": COSY_CLIENT_TYPE,
    ...opts.headers,
  };

  if (opts.bearer) {
    headers.Authorization = `Bearer ${creds.access}`;
  } else {
    const cosy = buildAuthHeaders(rawBodyForSign, opts.url, {
      userID: creds.userID,
      authToken: creds.access,
      name: creds.name,
      email: creds.email,
      machineID: creds.machineID,
    });
    Object.assign(headers, cosy);
  }

  if (bodyBytes) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }

  return fetch(opts.url, {
    method,
    headers,
    body: bodyBytes,
    signal: opts.signal,
  });
}

export async function qoderFetchJson<T = unknown>(opts: RequestOptions): Promise<T> {
  const res = await qoderFetch(opts);
  const text = await res.text();
  if (!res.ok) throw new QoderHttpError(res.status, res.statusText, text);
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
