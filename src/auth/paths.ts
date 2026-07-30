import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function configDir(): string {
  const override =
    process.env.QODER_RESERVE_CONFIG_DIR ||
    process.env.QODER_RESERVE_HOME ||
    "";
  if (override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), ".qoder-reserve");
}

export function authFilePath(): string {
  return path.join(configDir(), "auth.json");
}

export function accountsFilePath(): string {
  return path.join(configDir(), "accounts.json");
}

export function ensureConfigDir(): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
