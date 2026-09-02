import { isCn, patSettingsUrl, resolveMode } from "../config/endpoints.js";
import type {
  GlobalTier,
  LoginOptions,
  PoolAccount,
  QoderCredentials,
  QoderMode,
} from "../types.js";
import { runDeviceFlow } from "./device.js";
import { importOfficialCredentials } from "./import-official.js";
import { credentialsFromPat, envPat } from "./pat.js";
import { addAccount, accountToCredentials } from "./pool.js";
import { logError, logInfo, logWarn, maskSecret } from "../log.js";
import { configDir } from "./paths.js";
import { getMachineId } from "../crypto/machine-id.js";

export interface LoginToPoolOptions extends LoginOptions {
  name?: string;
  globalTier?: GlobalTier | string;
  /** If false, only return credentials without adding to pool. Default true. */
  addToPool?: boolean;
}

export async function loginCredentials(
  options: LoginOptions = {}
): Promise<QoderCredentials> {
  const mode: QoderMode = resolveMode(options.mode);
  const progress = options.onProgress || (() => undefined);
  logInfo(
    `login start mode=${mode} config=${configDir()} machine_id=${maskSecret(getMachineId(), 8)}`
  );

  if (options.pat?.trim()) {
    progress("Exchanging PAT...");
    try {
      return await credentialsFromPat(options.pat.trim(), mode);
    } catch (err) {
      logError("PAT login failed:", err);
      throw err;
    }
  }

  const fromEnv = envPat(mode);
  if (fromEnv) {
    progress("Exchanging PAT from environment...");
    try {
      return await credentialsFromPat(fromEnv, mode);
    } catch (err) {
      logError("PAT login from env failed:", err);
      throw err;
    }
  }

  progress("Trying official CLI credentials...");
  const imported = await importOfficialCredentials(mode);
  if (imported.ok && imported.credentials) {
    progress(`Imported official credentials (${imported.method})`);
    logInfo(`imported official credentials method=${imported.method}`);
    return imported.credentials;
  }
  logWarn(imported.error || "Official import failed");
  progress(imported.error || "Official import failed");

  if (isCn(mode)) {
    try {
      progress("Attempting CN browser device login...");
      return await runDeviceFlow({ ...options, mode });
    } catch (err) {
      logError("CN device login failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${msg}\n\nCN login: use PAT:\n  qoder-reserve accounts add --mode cn --pat pt-...\nCreate PAT at ${patSettingsUrl("cn")}`
      );
    }
  }

  progress("Starting browser device login...");
  return runDeviceFlow({ ...options, mode });
}

/** Login and add a new pool account (or return creds only). */
export async function login(options: LoginToPoolOptions = {}): Promise<QoderCredentials> {
  const mode = resolveMode(options.mode);
  const creds = await loginCredentials(options);
  if (options.addToPool === false) return creds;
  const acc = addAccount({
    mode,
    name: options.name,
    globalTier: options.globalTier,
    credentials: { ...creds, mode },
  });
  options.onProgress?.(`Added to pool: ${acc.name} (${acc.id.slice(0, 8)}…)`);
  return accountToCredentials(acc);
}

export async function loginToPool(
  options: LoginToPoolOptions = {}
): Promise<PoolAccount> {
  const mode = resolveMode(options.mode);
  const creds = await loginCredentials(options);
  return addAccount({
    mode,
    name: options.name,
    globalTier: options.globalTier,
    credentials: { ...creds, mode },
  });
}

export async function loginWithPat(
  pat: string,
  mode?: QoderMode,
  opts?: { name?: string; globalTier?: GlobalTier | string }
): Promise<QoderCredentials> {
  return login({ pat, mode, ...opts });
}
