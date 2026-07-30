import { USER_AGENT, resolveMode, urls } from "../config/endpoints.js";
import { getMachineId } from "../crypto/machine-id.js";
import type { QoderCredentials, QoderMode } from "../types.js";
import {
  credentialsFromPat,
  decodePatRefresh,
  isPatRefresh,
} from "./pat.js";

export async function refreshCredentials(
  credentials: QoderCredentials,
  mode: QoderMode = credentials.mode || resolveMode()
): Promise<QoderCredentials> {
  if (isPatRefresh(credentials.refresh) || credentials.pat) {
    const pat = credentials.pat || decodePatRefresh(credentials.refresh).pat;
    if (pat) {
      try {
        return await credentialsFromPat(pat, mode);
      } catch {
        /* fall through */
      }
    }
    return { ...credentials, expires: Date.now() + 60 * 60 * 1000 };
  }

  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] || "";
  const userID = parts[1] || credentials.userID;
  const machineID = parts[2] || credentials.machineID || getMachineId();
  if (!refreshToken) {
    return { ...credentials, expires: Date.now() + 60 * 60 * 1000 };
  }

  const u = urls(mode);
  // Prefer OpenAPI device refresh, then center refresh_token.
  const attempts: Array<{ url: string; body: Record<string, string> }> = [
    { url: u.deviceRefresh, body: { refresh_token: refreshToken } },
    { url: u.jobTokenRefresh, body: { refresh_token: refreshToken } },
    { url: u.refreshToken, body: { refreshToken } },
  ];

  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credentials.access}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(attempt.body),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as {
        token?: string;
        refresh_token?: string;
        expires_at?: string;
        expires_in?: number;
      };
      if (!data.token) continue;

      let expireMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
      if (data.expires_at) {
        const parsed = Date.parse(data.expires_at);
        if (!Number.isNaN(parsed)) expireMs = parsed;
      } else if (data.expires_in) {
        expireMs = Date.now() + data.expires_in * 1000;
      }

      return {
        ...credentials,
        mode,
        access: data.token,
        refresh: `${data.refresh_token || refreshToken}|${userID}|${machineID}`,
        expires: expireMs - 5 * 60 * 1000,
        userID,
        machineID,
      };
    } catch {
      /* try next */
    }
  }

  return { ...credentials, expires: Date.now() + 60 * 60 * 1000 };
}

export async function ensureFresh(
  credentials: QoderCredentials
): Promise<QoderCredentials> {
  if (Date.now() < credentials.expires - 30_000) return credentials;
  return refreshCredentials(credentials);
}
