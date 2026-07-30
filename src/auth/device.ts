import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { USER_AGENT, isCn, resolveMode, urls } from "../config/endpoints.js";
import { getMachineId } from "../crypto/machine-id.js";
import type { LoginOptions, QoderCredentials, QoderMode } from "../types.js";
import { fetchUserInfo } from "./pat.js";

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function parseExpiresAt(s?: string, expiresInSeconds?: number): number {
  if (s) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
    const ms = Number.parseInt(s, 10);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }
  if (expiresInSeconds && expiresInSeconds > 0) {
    return Date.now() + expiresInSeconds * 1000;
  }
  return Date.now() + 30 * 24 * 60 * 60 * 1000;
}

function openUrl(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* ignore */
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("Login cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error("Login cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runDeviceFlow(
  options: LoginOptions = {}
): Promise<QoderCredentials> {
  const mode: QoderMode = resolveMode(options.mode);
  const u = urls(mode);
  const { codeVerifier, codeChallenge } = generatePKCE();
  const nonce = crypto.randomUUID();
  const machineID = getMachineId();

  const verificationURI = `${u.deviceWeb}?challenge=${encodeURIComponent(codeChallenge)}&challenge_method=S256&machine_id=${encodeURIComponent(machineID)}&nonce=${encodeURIComponent(nonce)}`;

  options.onProgress?.("Complete login in your browser...");
  options.onAuthUrl?.(verificationURI);

  const shouldOpen =
    options.openBrowser !== false &&
    !process.env.NO_BROWSER &&
    process.env.NO_BROWSER !== "1";
  if (shouldOpen) openUrl(verificationURI);

  const pollURL = `${u.devicePoll}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(codeVerifier)}&challenge_method=S256`;
  const pollInterval = 2000;
  const maxAttempts = 90;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.signal?.aborted) throw new Error("Login cancelled");
    await delay(pollInterval, options.signal);

    const response = await fetch(pollURL, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: options.signal,
    });

    if (response.status === 202 || response.status === 404) continue;

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      // CN device endpoint may not exist
      if (isCn(mode) && (response.status === 404 || response.status === 501)) {
        throw new Error(
          `CN browser login unavailable (${response.status}). Use PAT from ${u.patSettings}`
        );
      }
      throw new Error(
        `Device token poll failed: ${response.status} ${response.statusText}. ${errText.slice(0, 200)}`
      );
    }

    const tokenData = (await response.json()) as {
      token?: string;
      refresh_token?: string;
      user_id?: string;
      expires_at?: string;
      expires_in?: number;
    };
    if (!tokenData.token) throw new Error("Device token poll returned empty access token");

    options.onProgress?.("Fetching user profile...");
    const profile = await fetchUserInfo(tokenData.token, mode);
    const userID = tokenData.user_id || profile.userID || "unknown";
    const expireMs = parseExpiresAt(tokenData.expires_at, tokenData.expires_in);

    options.onProgress?.("Login successful");
    return {
      mode,
      access: tokenData.token,
      refresh: `${tokenData.refresh_token || ""}|${userID}|${machineID}`,
      expires: expireMs - 5 * 60 * 1000,
      userID,
      email: profile.email || (isCn(mode) ? "user@qoder.com.cn" : "user@qoder.com"),
      name: profile.name || (isCn(mode) ? "Qoder CN User" : "Qoder User"),
      machineID,
    };
  }

  throw new Error("Authorization timed out");
}
