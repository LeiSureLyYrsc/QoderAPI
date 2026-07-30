import type { QoderCredentials, QoderMode } from "../types.js";
import { resolveMode } from "../config/endpoints.js";

export type DeviceSessionStatus = "pending" | "ok" | "error";

export interface DeviceSession {
  id: string;
  mode: QoderMode;
  status: DeviceSessionStatus;
  loginUrl?: string;
  error?: string;
  createdAt: number;
  progress?: string;
}

export interface UiSettings {
  defaultModel: string;
  proxyApiKey: string;
  theme: "dark" | "light";
}

const deviceSessions = new Map<string, DeviceSession>();

/** Default site preference when model id has no cn/ / global/ prefix. */
let defaultMode: QoderMode = resolveMode();
let settings: UiSettings = {
  defaultModel: "cn/auto",
  proxyApiKey: (process.env.PROXY_API_KEY || "").trim(),
  theme: "dark",
};

/** @deprecated use getDefaultMode — kept as alias for dual-mode routing. */
export function getMode(): QoderMode {
  return defaultMode;
}

export function getDefaultMode(): QoderMode {
  return defaultMode;
}

/** @deprecated use setDefaultMode */
export function setMode(mode: QoderMode): QoderMode {
  return setDefaultMode(mode);
}

export function setDefaultMode(mode: QoderMode): QoderMode {
  defaultMode = resolveMode(mode);
  return defaultMode;
}

export function getSettings(): UiSettings {
  return { ...settings };
}

export function updateSettings(patch: Partial<UiSettings>): UiSettings {
  settings = {
    ...settings,
    ...patch,
    proxyApiKey:
      patch.proxyApiKey !== undefined ? String(patch.proxyApiKey).trim() : settings.proxyApiKey,
    defaultModel:
      patch.defaultModel !== undefined
        ? String(patch.defaultModel).trim() || "auto"
        : settings.defaultModel,
    theme: patch.theme === "light" || patch.theme === "dark" ? patch.theme : settings.theme,
  };
  return getSettings();
}

export function getProxyApiKey(): string {
  return settings.proxyApiKey || (process.env.PROXY_API_KEY || "").trim();
}

export function createDeviceSession(mode: QoderMode): DeviceSession {
  const id = cryptoRandomId();
  const session: DeviceSession = {
    id,
    mode,
    status: "pending",
    createdAt: Date.now(),
  };
  deviceSessions.set(id, session);
  // GC old sessions (>30min)
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of deviceSessions) {
    if (v.createdAt < cutoff) deviceSessions.delete(k);
  }
  return session;
}

export function getDeviceSession(id: string): DeviceSession | undefined {
  return deviceSessions.get(id);
}

export function patchDeviceSession(id: string, patch: Partial<DeviceSession>): void {
  const s = deviceSessions.get(id);
  if (!s) return;
  Object.assign(s, patch);
}

export function publicCredential(creds: QoderCredentials | null | undefined) {
  if (!creds) return null;
  return {
    mode: creds.mode,
    userID: creds.userID,
    email: creds.email,
    name: creds.name,
    machineID: creds.machineID,
    expires: creds.expires,
    expiresAt: new Date(creds.expires).toISOString(),
    expired: Date.now() >= creds.expires,
    hasPat: Boolean(creds.pat || (creds.refresh && creds.refresh.startsWith("pat|"))),
  };
}

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
