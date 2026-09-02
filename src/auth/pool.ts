import crypto from "node:crypto";
import fs from "node:fs";
import type {
  AccountStatus,
  GlobalTier,
  PoolAccount,
  PoolErrorType,
  QoderCredentials,
  QoderMode,
} from "../types.js";
import type { ModelRoute } from "../config/routing.js";
import { accountsFilePath, authFilePath, ensureConfigDir } from "./paths.js";
import { logError } from "../log.js";

const RATE_LIMIT_MS = 60_000;
const SESSION_TTL_MS = 60 * 60 * 1000;

let rrIndex = 0;

export interface SessionBind {
  accountId: string;
  upstreamSessionId: string;
}

const sessionBinds = new Map<
  string,
  { accountId: string; upstreamSessionId: string; expiresAt: number }
>();

function gcSessionBinds(now = Date.now()): void {
  for (const [key, bind] of sessionBinds) {
    if (bind.expiresAt <= now) sessionBinds.delete(key);
  }
}

export function getSessionBind(sessionKey: string | undefined): SessionBind | null {
  if (!sessionKey) return null;
  gcSessionBinds();
  const hit = sessionBinds.get(sessionKey);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    sessionBinds.delete(sessionKey);
    return null;
  }
  return { accountId: hit.accountId, upstreamSessionId: hit.upstreamSessionId };
}

export function bindSession(
  sessionKey: string,
  accountId: string,
  upstreamSessionId?: string
): SessionBind {
  const existing = sessionBinds.get(sessionKey);
  const id = upstreamSessionId || existing?.upstreamSessionId || sessionKey;
  sessionBinds.set(sessionKey, {
    accountId,
    upstreamSessionId: id,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return { accountId, upstreamSessionId: id };
}

export function clearSessionBind(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  sessionBinds.delete(sessionKey);
}

export function clearSessionBindsForAccount(accountId: string): void {
  for (const [key, bind] of sessionBinds) {
    if (bind.accountId === accountId) sessionBinds.delete(key);
  }
}

/** Test helper — drop in-memory session stickiness. */
export function resetSessionBinds(): void {
  sessionBinds.clear();
}
/** Track which config dirs already ran migration. */
const migratedDirs = new Set<string>();

function normalizeTier(mode: QoderMode, tier?: string | null): GlobalTier {
  if (mode !== "global") return "pro";
  const t = String(tier || "pro").toLowerCase().replace(/-/g, "_");
  if (t === "only_ultimate" || t === "onlyultimate" || t === "non_pro" || t === "nonpro") {
    return "only_ultimate";
  }
  return "pro";
}

export function isUltimateModel(route: Pick<ModelRoute, "bareId" | "key">): boolean {
  const bare = String(route.bareId || "").toLowerCase();
  const key = String(route.key || "").toLowerCase();
  return bare === "ultimate" || key === "ultimate";
}

export function canServeModel(
  account: PoolAccount,
  route: Pick<ModelRoute, "mode" | "bareId" | "key">
): boolean {
  if (account.mode !== route.mode) return false;

  const now = Date.now();
  if (account.status === "rate_limited") {
    if (account.rateLimitUntil && now > account.rateLimitUntil) {
      // caller should persist recovery; treat as active for selection
    } else {
      return false;
    }
  } else if (account.status !== "active") {
    return false;
  }

  if (account.mode === "global" && account.globalTier === "only_ultimate") {
    return isUltimateModel(route);
  }
  return true;
}

function loadRaw(): PoolAccount[] {
  ensureMigrated();
  const file = accountsFilePath();
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(data)) return [];
    return data.map(normalizeAccount).filter(Boolean) as PoolAccount[];
  } catch {
    return [];
  }
}

function saveRaw(accounts: PoolAccount[]): void {
  const file = accountsFilePath();
  try {
    ensureConfigDir();
    fs.writeFileSync(file, JSON.stringify(accounts, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    logError(`failed to write accounts file ${file}:`, err);
    throw err;
  }
}

function normalizeAccount(raw: unknown): PoolAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const mode = a.mode === "global" ? "global" : a.mode === "cn" ? "cn" : null;
  if (!mode) return null;
  const access = String(a.access || "");
  if (!access && !a.pat) return null;
  const status = (["active", "rate_limited", "exhausted", "disabled"].includes(
    String(a.status)
  )
    ? String(a.status)
    : "active") as AccountStatus;

  return {
    id: String(a.id || crypto.randomUUID()),
    name: String(a.name || a.profileName || a.email || `${mode}-account`),
    mode,
    globalTier: normalizeTier(mode, a.globalTier as string),
    status,
    rateLimitUntil:
      a.rateLimitUntil == null || a.rateLimitUntil === ""
        ? null
        : Number(a.rateLimitUntil),
    errorCount: Number(a.errorCount || 0),
    addedAt: Number(a.addedAt || Date.now()),
    lastUsedAt: a.lastUsedAt != null ? Number(a.lastUsedAt) : undefined,
    access,
    refresh: String(a.refresh || ""),
    expires: Number(a.expires || Date.now() + 3600_000),
    userID: String(a.userID || a.user_id || "unknown"),
    email: String(a.email || ""),
    profileName: String(a.profileName || a.name || ""),
    machineID: String(a.machineID || ""),
    pat: a.pat ? String(a.pat) : undefined,
  };
}

/** One-time migrate legacy auth.json single-slot store into the pool. */
export function ensureMigrated(): void {
  const dir = ensureConfigDir();
  if (migratedDirs.has(dir)) return;
  migratedDirs.add(dir);

  const accountsPath = accountsFilePath();
  if (fs.existsSync(accountsPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
      // File present (even empty array) means pool is initialized — do not re-migrate.
      if (Array.isArray(existing)) return;
    } catch {
      /* continue migrate */
    }
  }
  const legacyPath = authFilePath();
  if (!fs.existsSync(legacyPath)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as Record<
      string,
      QoderCredentials
    >;
    const out: PoolAccount[] = [];
    for (const mode of ["cn", "global"] as const) {
      const c = legacy[mode];
      if (!c?.access) continue;
      out.push({
        id: crypto.randomUUID(),
        name: c.name || c.email || `${mode}-migrated`,
        mode,
        globalTier: "pro",
        status: "active",
        rateLimitUntil: null,
        errorCount: 0,
        addedAt: Date.now(),
        access: c.access,
        refresh: c.refresh || "",
        expires: c.expires || Date.now() + 3600_000,
        userID: c.userID || "unknown",
        email: c.email || "",
        profileName: c.name || "",
        machineID: c.machineID || "",
        pat: c.pat,
      });
    }
    if (out.length) {
      ensureConfigDir();
      fs.writeFileSync(accountsPath, JSON.stringify(out, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
    }
  } catch {
    /* ignore */
  }
}

export function listAccounts(): PoolAccount[] {
  return loadRaw();
}

export function getAccount(id: string): PoolAccount | null {
  return loadRaw().find((a) => a.id === id) || null;
}

export function accountToCredentials(acc: PoolAccount): QoderCredentials {
  return {
    mode: acc.mode,
    access: acc.access,
    refresh: acc.refresh,
    expires: acc.expires,
    userID: acc.userID,
    email: acc.email,
    name: acc.profileName || acc.name,
    machineID: acc.machineID,
    pat: acc.pat,
    accountId: acc.id,
  };
}

export function credentialsToAccountFields(
  creds: QoderCredentials
): Pick<
  PoolAccount,
  | "access"
  | "refresh"
  | "expires"
  | "userID"
  | "email"
  | "profileName"
  | "machineID"
  | "pat"
  | "mode"
> {
  return {
    mode: creds.mode,
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    userID: creds.userID,
    email: creds.email,
    profileName: creds.name,
    machineID: creds.machineID,
    pat: creds.pat,
  };
}

export function addAccount(input: {
  name?: string;
  mode: QoderMode;
  globalTier?: GlobalTier | string;
  credentials: QoderCredentials;
  status?: AccountStatus;
}): PoolAccount {
  const accounts = loadRaw();
  const fields = credentialsToAccountFields(input.credentials);
  const acc: PoolAccount = {
    id: crypto.randomUUID(),
    name:
      input.name ||
      fields.profileName ||
      fields.email ||
      `${input.mode}-${accounts.length + 1}`,
    globalTier: normalizeTier(input.mode, input.globalTier),
    status: input.status || "active",
    rateLimitUntil: null,
    errorCount: 0,
    addedAt: Date.now(),
    lastUsedAt: undefined,
    ...fields,
    mode: input.mode,
  };
  accounts.push(acc);
  saveRaw(accounts);
  return acc;
}

export function updateAccount(
  id: string,
  patch: Partial<
    Pick<
      PoolAccount,
      | "name"
      | "globalTier"
      | "status"
      | "rateLimitUntil"
      | "errorCount"
      | "lastUsedAt"
      | "access"
      | "refresh"
      | "expires"
      | "userID"
      | "email"
      | "profileName"
      | "machineID"
      | "pat"
    >
  >
): PoolAccount | null {
  const accounts = loadRaw();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const prev = accounts[idx]!;
  const next: PoolAccount = {
    ...prev,
    ...patch,
    globalTier:
      patch.globalTier != null
        ? normalizeTier(prev.mode, patch.globalTier)
        : prev.globalTier,
  };
  accounts[idx] = next;
  saveRaw(accounts);
  return next;
}

export function removeAccount(id: string): boolean {
  const accounts = loadRaw();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  saveRaw(next);
  return true;
}

function recoverRateLimits(accounts: PoolAccount[]): boolean {
  const now = Date.now();
  let changed = false;
  for (const acc of accounts) {
    if (
      acc.status === "rate_limited" &&
      acc.rateLimitUntil &&
      now > acc.rateLimitUntil
    ) {
      acc.status = "active";
      acc.rateLimitUntil = null;
      changed = true;
    }
  }
  return changed;
}

export function getAvailableAccounts(route: ModelRoute): PoolAccount[] {
  const accounts = loadRaw();
  if (recoverRateLimits(accounts)) saveRaw(accounts);
  return accounts.filter((a) => {
    if (a.mode !== route.mode) return false;
    if (a.status === "rate_limited") {
      // recovered ones already active
      if (a.rateLimitUntil && Date.now() <= a.rateLimitUntil) return false;
    } else if (a.status !== "active") {
      return false;
    }
    if (a.mode === "global" && a.globalTier === "only_ultimate") {
      return isUltimateModel(route);
    }
    return true;
  });
}

export function countAvailable(route: ModelRoute): number {
  return getAvailableAccounts(route).length;
}

export function getNextAvailable(route: ModelRoute): PoolAccount | null {
  const available = getAvailableAccounts(route);
  if (!available.length) return null;
  rrIndex = (rrIndex + 1) % available.length;
  const picked = available[rrIndex]!;
  updateAccount(picked.id, { lastUsedAt: Date.now() });
  return getAccount(picked.id);
}

/**
 * Sticky account for a client session. Reuses the bound account while it can
 * still serve the route; otherwise round-robins and rebinds.
 */
export function getAccountForSession(
  route: ModelRoute,
  sessionKey?: string,
  tried?: Set<string>
): PoolAccount | null {
  if (sessionKey) {
    const bind = getSessionBind(sessionKey);
    if (bind && !tried?.has(bind.accountId)) {
      const acc = getAccount(bind.accountId);
      if (acc && canServeModel(acc, route)) {
        bindSession(sessionKey, acc.id, bind.upstreamSessionId);
        return acc;
      }
    }
    if (bind) clearSessionBind(sessionKey);
  }

  const available = getAvailableAccounts(route).filter(
    (a) => !tried?.has(a.id)
  );
  if (!available.length) return null;
  rrIndex = (rrIndex + 1) % available.length;
  const picked = available[rrIndex]!;
  updateAccount(picked.id, { lastUsedAt: Date.now() });
  const acc = getAccount(picked.id);
  if (acc && sessionKey) bindSession(sessionKey, acc.id);
  return acc;
}

export function reportError(id: string, type: PoolErrorType): PoolAccount | null {
  const accounts = loadRaw();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const acc = accounts[idx]!;
  acc.errorCount = (acc.errorCount || 0) + 1;
  if (type === "rate_limit") {
    acc.status = "rate_limited";
    acc.rateLimitUntil = Date.now() + RATE_LIMIT_MS;
  } else if (type === "quota_exhausted") {
    acc.status = "exhausted";
    acc.rateLimitUntil = null;
  } else if (type === "auth_error") {
    acc.status = "disabled";
    acc.rateLimitUntil = null;
  }
  accounts[idx] = acc;
  saveRaw(accounts);
  clearSessionBindsForAccount(id);
  return acc;
}

export function publicAccount(acc: PoolAccount) {
  return {
    id: acc.id,
    name: acc.name,
    mode: acc.mode,
    globalTier: acc.mode === "global" ? acc.globalTier : undefined,
    status: acc.status,
    rateLimitUntil: acc.rateLimitUntil,
    errorCount: acc.errorCount,
    addedAt: acc.addedAt,
    lastUsedAt: acc.lastUsedAt,
    userID: acc.userID,
    email: acc.email,
    profileName: acc.profileName,
    expires: acc.expires,
    expiresAt: new Date(acc.expires).toISOString(),
    expired: Date.now() >= acc.expires,
    hasPat: Boolean(acc.pat),
    accessMasked: acc.access
      ? `${acc.access.slice(0, 4)}…${acc.access.slice(-4)}`
      : "",
  };
}

export function poolSummary() {
  const accounts = loadRaw();
  if (recoverRateLimits(accounts)) saveRaw(accounts);
  const byMode = (mode: QoderMode) => accounts.filter((a) => a.mode === mode);
  const cn = byMode("cn");
  const global = byMode("global");
  return {
    total: accounts.length,
    cn: {
      total: cn.length,
      active: cn.filter((a) => a.status === "active").length,
    },
    global: {
      total: global.length,
      active: global.filter((a) => a.status === "active").length,
      pro: global.filter((a) => a.globalTier === "pro").length,
      onlyUltimate: global.filter((a) => a.globalTier === "only_ultimate").length,
    },
  };
}

/** Compatibility: first active account for mode (legacy single-slot callers). */
export function getCredentials(mode: QoderMode): QoderCredentials | null {
  const accounts = loadRaw();
  if (recoverRateLimits(accounts)) saveRaw(accounts);
  const hit =
    accounts.find((a) => a.mode === mode && a.status === "active") ||
    accounts.find((a) => a.mode === mode);
  return hit ? accountToCredentials(hit) : null;
}

/** Compatibility write: upsert single slot as a pool account (legacy). */
export function saveCredentials(creds: QoderCredentials): PoolAccount {
  if (creds.accountId) {
    const updated = updateAccount(creds.accountId, {
      ...credentialsToAccountFields(creds),
      status: "active",
      rateLimitUntil: null,
    });
    if (updated) return updated;
  }
  // Prefer updating existing same userID+mode
  const accounts = loadRaw();
  const existing = accounts.find(
    (a) => a.mode === creds.mode && a.userID && a.userID === creds.userID
  );
  if (existing) {
    return (
      updateAccount(existing.id, {
        ...credentialsToAccountFields(creds),
        status: "active",
        rateLimitUntil: null,
        name: existing.name,
      }) || existing
    );
  }
  return addAccount({
    mode: creds.mode,
    name: creds.name || creds.email,
    credentials: creds,
    globalTier: "pro",
  });
}

export function clearCredentials(mode?: QoderMode): void {
  if (!mode) {
    saveRaw([]);
    return;
  }
  saveRaw(loadRaw().filter((a) => a.mode !== mode));
}

/** @deprecated legacy shape */
export type AuthStore = Partial<Record<QoderMode, QoderCredentials>>;

export function loadAuthStore(): AuthStore {
  const out: AuthStore = {};
  for (const mode of ["cn", "global"] as const) {
    const c = getCredentials(mode);
    if (c) out[mode] = c;
  }
  return out;
}

export function classifyProviderError(
  status: number,
  bodyText: string
): PoolErrorType | null {
  const t = `${status} ${bodyText}`.toLowerCase();
  if (
    status === 429 ||
    t.includes("rate limit") ||
    t.includes("too many requests") ||
    t.includes("rate_limit")
  ) {
    return "rate_limit";
  }
  if (
    t.includes("quota") ||
    t.includes("credit usage limit") ||
    t.includes("usage limit") ||
    t.includes("insufficient") ||
    t.includes("exhausted")
  ) {
    return "quota_exhausted";
  }
  if (status === 401 || status === 403 || t.includes("unauthorized") || t.includes("auth")) {
    return "auth_error";
  }
  return null;
}
