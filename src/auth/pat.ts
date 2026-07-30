import {
  COSY_CLIENT_TYPE,
  COSY_VERSION,
  USER_AGENT,
  isCn,
  resolveMode,
  urls,
} from "../config/endpoints.js";
import { getMachineId } from "../crypto/machine-id.js";
import type { QoderCredentials, QoderMode } from "../types.js";

const PAT_PREFIX = "pat";

export function isPatRefresh(refresh: string): boolean {
  return refresh.startsWith(`${PAT_PREFIX}|`);
}

export function encodePatRefresh(
  pat: string,
  jobRefreshToken: string,
  userID: string,
  machineID: string
): string {
  return [PAT_PREFIX, pat, jobRefreshToken, userID, machineID].join("|");
}

export function decodePatRefresh(refresh: string): {
  pat: string;
  jobRefreshToken: string;
  userID: string;
  machineID: string;
} {
  const parts = refresh.split("|");
  return {
    pat: parts[1] || "",
    jobRefreshToken: parts[2] || "",
    userID: parts[3] || "",
    machineID: parts[4] || "",
  };
}

function parseExpires(data: {
  expires_at?: string;
  expires_in?: number | string;
}): number {
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (data.expires_in != null) {
    const n = Number(data.expires_in);
    if (!Number.isNaN(n) && n > 0) {
      // API may return ms or seconds; treat large values as ms.
      return Date.now() + (n > 1e12 ? n - Date.now() : n > 1e10 ? n : n * 1000);
    }
  }
  return Date.now() + 24 * 60 * 60 * 1000;
}

export async function exchangeJobToken(
  pat: string,
  mode: QoderMode = resolveMode()
): Promise<{ jobToken: string; jobRefreshToken: string; expiresAt: number }> {
  const res = await fetch(urls(mode).exchange, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "Cosy-Version": COSY_VERSION,
      "Cosy-ClientType": COSY_CLIENT_TYPE,
    },
    body: JSON.stringify({ personal_token: pat }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `PAT exchange failed (${mode}): ${res.status} ${res.statusText}. ${text.slice(0, 300)}`
    );
  }
  const data = (await res.json()) as {
    token?: string;
    refresh_token?: string;
    expires_at?: string;
    expires_in?: number | string;
  };
  if (!data.token) throw new Error("PAT exchange returned no job token");
  return {
    jobToken: data.token,
    jobRefreshToken: data.refresh_token || "",
    expiresAt: parseExpires(data),
  };
}

export async function fetchUserInfo(
  jobToken: string,
  mode: QoderMode = resolveMode()
): Promise<{ userID: string; email: string; name: string }> {
  try {
    const res = await fetch(urls(mode).userinfo, {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Cosy-Version": COSY_VERSION,
        "Cosy-ClientType": COSY_CLIENT_TYPE,
      },
    });
    if (!res.ok) return { userID: "", email: "", name: "" };
    const info = (await res.json()) as {
      id?: string;
      email?: string;
      name?: string;
      username?: string;
    };
    return {
      userID: info.id || "",
      email: info.email || "",
      name: info.name || info.username || "",
    };
  } catch {
    return { userID: "", email: "", name: "" };
  }
}

export async function credentialsFromPat(
  pat: string,
  mode: QoderMode = resolveMode()
): Promise<QoderCredentials> {
  const { jobToken, jobRefreshToken, expiresAt } = await exchangeJobToken(pat, mode);
  const { userID, email, name } = await fetchUserInfo(jobToken, mode);
  const machineID = getMachineId();
  return {
    mode,
    access: jobToken,
    refresh: encodePatRefresh(pat, jobRefreshToken, userID, machineID),
    expires: expiresAt - 5 * 60 * 1000,
    userID: userID || "unknown",
    email: email || (isCn(mode) ? "user@qoder.com.cn" : "user@qoder.com"),
    name: name || (isCn(mode) ? "Qoder CN User" : "Qoder User"),
    machineID,
    pat,
  };
}

export function envPat(mode: QoderMode): string {
  if (mode === "cn") {
    return (
      process.env.QODERCN_API_KEY ||
      process.env.QODERCN_PERSONAL_ACCESS_TOKEN ||
      process.env.QODERCN_PAT ||
      process.env.QODER_PERSONAL_ACCESS_TOKEN ||
      ""
    ).trim();
  }
  return (
    process.env.QODER_API_KEY ||
    process.env.QODER_PERSONAL_ACCESS_TOKEN ||
    process.env.QODER_PAT ||
    ""
  ).trim();
}
