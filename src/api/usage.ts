import { isCn, resolveMode, urls } from "../config/endpoints.js";
import { getCredentials } from "../auth/store.js";
import type { QoderCredentials, QoderMode, UsageInfo } from "../types.js";
import { qoderFetchJson } from "./client.js";

async function getUsageForMode(
  mode: QoderMode,
  credentials?: QoderCredentials
): Promise<UsageInfo> {
  const raw = await qoderFetchJson<Record<string, unknown>>({
    method: "GET",
    url: urls(mode).usage,
    bearer: true,
    mode,
    credentials,
  });

  const buckets: UsageInfo["buckets"] = [];
  const userQuota = raw?.userQuota as
    | { used?: number; total?: number; remaining?: number; unit?: string }
    | undefined;
  if (userQuota) {
    buckets.push({
      id: "user-quota",
      label: "User Quota",
      used: Number(userQuota.used ?? 0),
      total: Number(userQuota.total ?? 0),
      remaining: userQuota.remaining != null ? Number(userQuota.remaining) : undefined,
      unit: userQuota.unit,
      resetAt: raw.expiresAt ? String(raw.expiresAt) : undefined,
    });
  }
  const org = raw?.orgResourcePackage as
    | { used?: number; total?: number; unit?: string }
    | undefined;
  if (org && Number(org.total ?? 0) > 0) {
    buckets.push({
      id: "org-resource-package",
      label: "Org Resource Package",
      used: Number(org.used ?? 0),
      total: Number(org.total ?? 0),
      unit: org.unit,
      resetAt: raw.expiresAt ? String(raw.expiresAt) : undefined,
    });
  }

  const summary = userQuota
    ? `${Number(userQuota.remaining ?? userQuota.total! - userQuota.used!).toFixed(2)} ${userQuota.unit || ""} remaining`.trim()
    : isCn(mode)
      ? "Qoder CN usage"
      : "Qoder usage";

  return { summary, raw, buckets };
}

export async function getUsage(options?: {
  mode?: QoderMode | "all" | string | null;
  credentials?: QoderCredentials;
}): Promise<UsageInfo> {
  const raw = String(options?.mode ?? "").toLowerCase();
  if (raw === "all" || raw === "both" || raw === "*") {
    throw new Error("Use getUsageAll() for dual-site usage");
  }
  const mode = resolveMode(options?.mode);
  return getUsageForMode(mode, options?.credentials);
}

export async function getUsageAll(): Promise<{
  cn?: UsageInfo | { error: string };
  global?: UsageInfo | { error: string };
}> {
  const out: {
    cn?: UsageInfo | { error: string };
    global?: UsageInfo | { error: string };
  } = {};

  await Promise.all(
    (["cn", "global"] as const).map(async (mode) => {
      if (!getCredentials(mode)) {
        out[mode] = { error: "not logged in" };
        return;
      }
      try {
        out[mode] = await getUsageForMode(mode);
      } catch (e) {
        out[mode] = { error: e instanceof Error ? e.message : String(e) };
      }
    })
  );
  return out;
}
