import type { QoderMode } from "../types.js";
import { CN_MODEL_ALIASES, resolveMode } from "./endpoints.js";
import { getCredentials } from "../auth/store.js";

export interface ParsedModelRef {
  /** Explicit mode from prefix, if any. */
  mode?: QoderMode;
  /** Id without site prefix. */
  bareId: string;
  raw: string;
}

export interface ModelRoute {
  mode: QoderMode;
  bareId: string;
  /** Gateway model key. */
  key: string;
  /** Canonical public id: cn/... or global/... */
  publicId: string;
}

const PREFIX_RE =
  /^(?<mode>cn|china|qodercn|qoder-cn|global|intl|international|g|qoder)(?:[/:_-])(?<rest>.+)$/i;

/** CN-only bare ids (not typically on global). */
const CN_ONLY = new Set([
  "qoder-cn",
  "qwen3.7-flash",
  "qwen3.6-flash",
  "q36fmodel",
  "qfmodel",
  "minimax-m2.7",
  "glm-5.3",
]);

/** Global-only bare ids (not typically on CN). */
const GLOBAL_ONLY = new Set([
  "ultimate",
  "performance",
  "efficient",
  "lite",
  "cantus",
  "cmodel",
  "kimi-k3",
  "kmodel_latest",
  "minimax-m3",
]);

export function publicModelId(mode: QoderMode, bareId: string): string {
  return `${mode}/${bareId}`;
}

export function parseModelRef(modelId: string): ParsedModelRef {
  const raw = String(modelId || "").trim();
  if (!raw) return { bareId: "auto", raw: "auto" };

  const m = PREFIX_RE.exec(raw);
  if (m?.groups?.mode && m.groups.rest) {
    const modeTok = m.groups.mode.toLowerCase();
    const mode: QoderMode =
      modeTok === "cn" ||
      modeTok === "china" ||
      modeTok === "qodercn" ||
      modeTok === "qoder-cn"
        ? "cn"
        : "global";
    return { mode, bareId: m.groups.rest.trim() || "auto", raw };
  }
  return { bareId: raw, raw };
}

export function gatewayKeyFor(bareId: string, mode: QoderMode): string {
  const id = bareId || "auto";
  if (mode === "cn") {
    return CN_MODEL_ALIASES[id] || CN_MODEL_ALIASES[id.toLowerCase()] || id;
  }
  // Global: accept friendly aliases too
  if (CN_MODEL_ALIASES[id] && !GLOBAL_ONLY.has(id)) {
    // e.g. qwen3.7-max → qmodel_latest still valid on global in many builds
    return CN_MODEL_ALIASES[id]!;
  }
  const lower = id.toLowerCase();
  const globalMap: Record<string, string> = {
    cantus: "cmodel",
    "kimi-k3": "kmodel_latest",
    "minimax-m3": "mmodel",
    "qwen3.7-plus": "qmodel",
    "qwen3.7-max": "qmodel_latest",
    "qwen3.8-max": "qmodel_preview",
    "qwen3.8-max-preview": "qmodel_preview",
    "deepseek-v4-pro": "dmodel",
    "deepseek-v4-flash": "dfmodel",
    "glm-5.3": "gm53model",
    "glm-5.2": "gm51model",
    "kimi-k2.7-code": "kmodel",
    "kimi-k2.6": "kmodel",
  };
  return globalMap[lower] || globalMap[id] || id;
}

function inferModeFromBareId(bareId: string): QoderMode | undefined {
  const id = bareId.toLowerCase();
  if (CN_ONLY.has(bareId) || CN_ONLY.has(id)) return "cn";
  if (GLOBAL_ONLY.has(bareId) || GLOBAL_ONLY.has(id)) return "global";
  return undefined;
}

export interface ResolveModelRouteOptions {
  /** Explicit mode override (request body / CLI flag). */
  preferredMode?: QoderMode | string | null;
  /** Default preference when bare id is ambiguous. */
  defaultMode?: QoderMode | string | null;
  /** If set, only consider this mode. */
  forceMode?: QoderMode | string | null;
}

/**
 * Resolve which site + gateway key a model id maps to.
 * Prefers explicit prefixes (cn/auto, global/lite).
 */
export function resolveModelRoute(
  modelId: string,
  options: ResolveModelRouteOptions = {}
): ModelRoute {
  if (options.forceMode) {
    const mode = resolveMode(options.forceMode);
    const bareId = parseModelRef(modelId).bareId;
    return {
      mode,
      bareId,
      key: gatewayKeyFor(bareId, mode),
      publicId: publicModelId(mode, bareId),
    };
  }

  const parsed = parseModelRef(modelId);
  let mode = parsed.mode;

  if (!mode) {
    mode = inferModeFromBareId(parsed.bareId);
  }

  if (!mode && options.preferredMode) {
    mode = resolveMode(options.preferredMode);
  }

  if (!mode) {
    // Prefer site that has any pool account
    const cnOk = Boolean(getCredentials("cn"));
    const gOk = Boolean(getCredentials("global"));
    if (cnOk && !gOk) mode = "cn";
    else if (gOk && !cnOk) mode = "global";
  }

  if (!mode && options.defaultMode) {
    mode = resolveMode(options.defaultMode);
  }

  if (!mode) {
    mode = resolveMode(null);
  }

  const bareId = parsed.bareId || "auto";
  return {
    mode,
    bareId,
    key: gatewayKeyFor(bareId, mode),
    publicId: publicModelId(mode, bareId),
  };
}
