import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir } from "../auth/paths.js";

const OFFICIAL_PATHS = [
  path.join(os.homedir(), ".qoder-cn", ".auth", "machine_id"),
  path.join(os.homedir(), ".qoder", ".auth", "machine_id"),
  path.join(os.homedir(), ".pi", "agent", "qoder-machine-id"),
];

function readFirstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const val = fs.readFileSync(p, "utf8").trim();
        if (val) return val;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function getMachineId(): string {
  const existing = readFirstExisting([
    path.join(configDir(), "machine_id"),
    ...OFFICIAL_PATHS,
  ]);
  if (existing) return existing;

  const id = crypto.randomUUID();
  try {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "machine_id"), id, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* ignore */
  }
  return id;
}
