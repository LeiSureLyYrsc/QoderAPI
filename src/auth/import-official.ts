import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QoderCredentials, QoderMode } from "../types.js";
import { getMachineId } from "../crypto/machine-id.js";
import { credentialsFromPat } from "./pat.js";
import { logInfo, logWarn } from "../log.js";

export interface OfficialAuthPaths {
  mode: QoderMode;
  userFile: string;
  machineIdFile: string;
}

export function officialAuthPaths(mode: QoderMode): OfficialAuthPaths {
  const root =
    mode === "cn"
      ? path.join(os.homedir(), ".qoder-cn")
      : path.join(os.homedir(), ".qoder");
  return {
    mode,
    userFile: path.join(root, ".auth", "user"),
    machineIdFile: path.join(root, ".auth", "machine_id"),
  };
}

function tryParseJsonUser(raw: string): Partial<QoderCredentials> | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const access =
      (j.access as string) ||
      (j.token as string) ||
      (j.access_token as string) ||
      (j.security_oauth_token as string) ||
      "";
    const userID = String(j.userID || j.user_id || j.id || j.uid || "");
    if (!access && !j.personal_token && !j.pat) return null;
    return {
      access,
      refresh: String(j.refresh || j.refresh_token || ""),
      expires: Number(j.expires || j.expires_at || Date.now() + 3600_000),
      userID,
      email: String(j.email || ""),
      name: String(j.name || j.username || ""),
      machineID: String(j.machineID || j.machine_id || getMachineId()),
      pat: (j.personal_token || j.pat || j.personalAccessToken) as string | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Official CLI encrypts ~/.qoder(-cn)/.auth/user with AES-256-GCM.
 * Key material may come from keytar / machine-bound secrets.
 * We try:
 *  1) plain JSON (debug / older formats)
 *  2) iv:tag:ciphertext hex AES-256-GCM with common derived keys
 *  3) look for PAT-like strings in nearby config files
 */
function deriveCandidateKeys(machineId: string): Buffer[] {
  const seeds = [
    machineId,
    `qoder-cli:${machineId}`,
    `qoder-cli-cn:${machineId}`,
    `qoder:${machineId}`,
    "qoder-cli",
    "qoder-cli-cn",
  ];
  const keys: Buffer[] = [];
  for (const seed of seeds) {
    keys.push(crypto.createHash("sha256").update(seed).digest());
    keys.push(crypto.scryptSync(seed, "qoder-salt", 32));
    keys.push(crypto.scryptSync(seed, machineId, 32));
  }
  // Hardcoded constant observed near credential code in bundle (may be aad/salt related).
  keys.push(
    Buffer.from([
      44, 6, 96, 159, 67, 137, 172, 134, 152, 52, 157, 248, 15, 219, 49, 114, 225, 17, 195, 37, 71,
      151, 145, 95, 214, 226, 9, 169, 250, 96, 125, 232,
    ])
  );
  return keys;
}

function tryDecryptAesGcm(blob: string, machineId: string): string | null {
  const trimmed = blob.trim();
  // Format A: ivHex:tagHex:cipherHex
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    if (parts.length === 3) {
      const [ivHex, tagHex, dataHex] = parts;
      try {
        const iv = Buffer.from(ivHex!, "hex");
        const tag = Buffer.from(tagHex!, "hex");
        const data = Buffer.from(dataHex!, "hex");
        for (const key of deriveCandidateKeys(machineId)) {
          try {
            const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
            decipher.setAuthTag(tag);
            const out = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
            if (out.includes("{") || out.includes("token")) return out;
          } catch {
            /* next key */
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Format B: base64 whole blob — try as opaque (unlikely)
  try {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length > 28) {
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(buf.length - 16);
      const data = buf.subarray(12, buf.length - 16);
      for (const key of deriveCandidateKeys(machineId)) {
        try {
          const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
          decipher.setAuthTag(tag);
          const out = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
          if (out.includes("{") || out.includes("token")) return out;
        } catch {
          /* next */
        }
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

function findPatNearby(mode: QoderMode): string | null {
  const roots =
    mode === "cn"
      ? [path.join(os.homedir(), ".qoder-cn"), path.join(os.homedir(), ".qoderworkcn")]
      : [path.join(os.homedir(), ".qoder"), path.join(os.homedir(), ".qoderwork")];

  const candidates = [
    ...roots.map((r) => path.join(r, "settings.json")),
    ...roots.map((r) => path.join(r, "state.json")),
    path.join(os.homedir(), ".pi", "agent", "auth.json"),
  ];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      const m = text.match(/pt-[A-Za-z0-9_\-.]{10,}/);
      if (m) return m[0]!;
      const j = JSON.parse(text) as Record<string, unknown>;
      const nested = JSON.stringify(j);
      const m2 = nested.match(/pt-[A-Za-z0-9_\-.]{10,}/);
      if (m2) return m2[0]!;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export interface ImportResult {
  ok: boolean;
  credentials?: QoderCredentials;
  method?: "json" | "decrypt" | "nearby-pat";
  error?: string;
}

export async function importOfficialCredentials(mode: QoderMode): Promise<ImportResult> {
  const paths = officialAuthPaths(mode);
  let machineId = getMachineId();
  try {
    if (fs.existsSync(paths.machineIdFile)) {
      machineId = fs.readFileSync(paths.machineIdFile, "utf8").trim() || machineId;
    }
  } catch {
    /* ignore */
  }

  if (!fs.existsSync(paths.userFile)) {
    // Still try nearby PAT
    const pat = findPatNearby(mode);
    if (pat) {
      const creds = await credentialsFromPat(pat, mode);
      logInfo(`imported nearby PAT from sibling config (${mode})`);
      return { ok: true, credentials: creds, method: "nearby-pat" };
    }
    logWarn(`official auth file not found: ${paths.userFile}`);
    return {
      ok: false,
      error: `Official auth file not found: ${paths.userFile}`,
    };
  }

  const raw = fs.readFileSync(paths.userFile, "utf8");

  const asJson = tryParseJsonUser(raw);
  if (asJson?.pat) {
      const creds = await credentialsFromPat(asJson.pat, mode);
      logInfo(`imported official credentials method=json (${mode})`);
      return { ok: true, credentials: creds, method: "json" };
  }
  if (asJson?.access) {
    const creds: QoderCredentials = {
      mode,
      access: asJson.access,
      refresh: asJson.refresh || "",
      expires: typeof asJson.expires === "number" ? asJson.expires : Date.now() + 3600_000,
      userID: asJson.userID || "unknown",
      email: asJson.email || "",
      name: asJson.name || "",
      machineID: asJson.machineID || machineId,
      pat: asJson.pat,
    };
      logInfo(`imported official credentials method=json-access (${mode})`);
      return { ok: true, credentials: creds, method: "json" };
  }

  const decrypted = tryDecryptAesGcm(raw, machineId);
  if (decrypted) {
    const parsed = tryParseJsonUser(decrypted);
    if (parsed?.pat) {
      const creds = await credentialsFromPat(parsed.pat, mode);
      return { ok: true, credentials: creds, method: "decrypt" };
    }
    if (parsed?.access) {
      const creds: QoderCredentials = {
        mode,
        access: parsed.access,
        refresh: parsed.refresh || "",
        expires: typeof parsed.expires === "number" ? parsed.expires : Date.now() + 3600_000,
        userID: parsed.userID || "unknown",
        email: parsed.email || "",
        name: parsed.name || "",
        machineID: parsed.machineID || machineId,
        pat: parsed.pat,
      };
      return { ok: true, credentials: creds, method: "decrypt" };
    }
    // decrypted text might be the token itself
    if (decrypted.startsWith("pt-")) {
      const creds = await credentialsFromPat(decrypted.trim(), mode);
      return { ok: true, credentials: creds, method: "decrypt" };
    }
  }

  const nearby = findPatNearby(mode);
  if (nearby) {
    const creds = await credentialsFromPat(nearby, mode);
    return { ok: true, credentials: creds, method: "nearby-pat" };
  }

  logWarn(`could not decrypt official credential file ${paths.userFile}`);
  return {
    ok: false,
    error:
      `Could not decrypt official credential file (${paths.userFile}). ` +
      `AES-256-GCM key is machine/keytar-bound. Use PAT login instead.`,
  };
}
