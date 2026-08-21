import {
  CN_KEY_TO_FRIENDLY,
  isCn,
  resolveMode,
  urls,
} from "../config/endpoints.js";
import { publicModelId } from "../config/routing.js";
import { getCredentials } from "../auth/store.js";
import type { ModelInfo, QoderCredentials, QoderMode } from "../types.js";
import { qoderFetch } from "./client.js";

type ModeFilter = QoderMode | "all";

function tag(mode: QoderMode, bare: Omit<ModelInfo, "id" | "mode" | "localId"> & { localId?: string }): ModelInfo {
  const localId = bare.localId || bare.key;
  return {
    ...bare,
    localId,
    mode,
    id: publicModelId(mode, localId),
  };
}

/** Aligned with `qodercli --list-models` (Global Pro). */
const STATIC_GLOBAL_BARE = [
  { localId: "auto", name: "Auto", key: "auto", contextWindow: 180000, maxTokens: 32768, reasoning: true, supportsEffort: false, input: ["text", "image"] as Array<"text" | "image"> },
  { localId: "ultimate", name: "Ultimate", key: "ultimate", contextWindow: 1000000, maxTokens: 32768, reasoning: true, supportsEffort: true, input: ["text", "image"] as Array<"text" | "image"> },
  { localId: "performance", name: "Performance", key: "performance", contextWindow: 1000000, maxTokens: 32768, reasoning: true, supportsEffort: true, input: ["text", "image"] as Array<"text" | "image"> },
  { localId: "efficient", name: "Efficient", key: "efficient", contextWindow: 180000, maxTokens: 32768, reasoning: true, supportsEffort: false, input: ["text", "image"] as Array<"text" | "image"> },
  { localId: "lite", name: "Lite", key: "lite", contextWindow: 180000, maxTokens: 32768, reasoning: false, supportsEffort: false, input: ["text"] as Array<"text" | "image"> },
  { localId: "cantus", name: "Cantus", key: "cmodel", contextWindow: 1000000, maxTokens: 32768, reasoning: true, supportsEffort: true, input: ["text", "image"] as Array<"text" | "image"> },
  { localId: "qwen3.8-max-preview", name: "Qwen3.8-Max-Preview", key: "qmodel_preview", contextWindow: 1000000, maxTokens: 32768, reasoning: true, supportsEffort: true, input: ["text", "image"] as Array<"text" | "image"> },
  { localId: "qwen3.7-max", name: "Qwen3.7-Max", key: "qmodel_latest", contextWindow: 1000000, maxTokens: 32768, reasoning: true, supportsEffort: true, input: ["text", "image"] as Array<"text" | "image"> },
  { localId: "qwen3.7-plus", name: "Qwen3.7-Plus", key: "qmodel", contextWindow: 1000000, maxTokens: 32768, reasoning: true, supportsEffort: false, input: ["text", "image"] as Array<"text" | "image"> },
  { localId: "kimi-k3", name: "Kimi-K3", key: "kmodel_latest", contextWindow: 256000, maxTokens: 32768, reasoning: true, supportsEffort: false, input: ["text", "image"] as Array<"text" | "image"> },
  { localId: "kimi-k2.7-code", name: "Kimi-K2.7-Code", key: "kmodel", contextWindow: 256000, maxTokens: 32768, reasoning: true, supportsEffort: false, input: ["text", "image"] as Array<"text" | "image"> },
  { localId: "glm-5.2", name: "GLM-5.2", key: "gm51model", contextWindow: 200000, maxTokens: 32768, reasoning: true, supportsEffort: false, input: ["text", "image"] as Array<"text" | "image"> },
  { localId: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", key: "dmodel", contextWindow: 1000000, maxTokens: 32768, reasoning: true, supportsEffort: false, input: ["text"] as Array<"text" | "image"> },
  { localId: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", key: "dfmodel", contextWindow: 1000000, maxTokens: 32768, reasoning: false, supportsEffort: false, input: ["text"] as Array<"text" | "image"> },
  { localId: "minimax-m3", name: "MiniMax-M3", key: "mmodel", contextWindow: 200000, maxTokens: 32768, reasoning: false, supportsEffort: false, input: ["text"] as Array<"text" | "image"> },
];

function staticModels(mode: QoderMode): ModelInfo[] {
  if (mode === "cn") {
    return Object.entries(CN_KEY_TO_FRIENDLY).map(([key, info]) =>
      tag(mode, {
        localId: info.id,
        name: info.name,
        key,
        contextWindow:
          key.includes("mmodel") || key.includes("gm")
            ? 200000
            : key.includes("kmodel")
              ? 256000
              : 1000000,
        maxTokens: 32768,
        reasoning: !["dfmodel", "mmodel"].includes(key),
        supportsEffort: ["qmodel_preview", "qmodel_latest"].includes(key),
        input: ["dfmodel", "mmodel", "qmodel", "qfmodel", "q36fmodel"].includes(key)
          ? ["text"]
          : ["text", "image"],
      })
    );
  }
  return STATIC_GLOBAL_BARE.map((m) =>
    tag(mode, {
      ...m,
      name: `${m.name} · Global`,
    })
  );
}

function normalizeModelList(raw: unknown, mode: QoderMode): ModelInfo[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as { data?: unknown[]; models?: unknown[]; list?: unknown[] }).data ||
          (raw as { models?: unknown[] }).models ||
          (raw as { list?: unknown[] }).list ||
          [])
      : [];

  const out: ModelInfo[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const key = String(m.key || m.id || m.model_key || m.modelKey || "");
    if (!key) continue;
    const friendly = isCn(mode) ? CN_KEY_TO_FRIENDLY[key] : null;
    const localId = friendly?.id || key;
    out.push(
      tag(mode, {
        localId,
        name:
          friendly?.name ||
          `${String(m.display_name || m.displayName || m.name || key)}${
            mode === "global" ? " · Global" : ""
          }`,
        key,
        contextWindow: Number(m.context_window || m.contextWindow || m.max_context || 180000),
        maxTokens: Number(m.max_output_tokens || m.maxOutputTokens || m.max_tokens || 32768),
        reasoning: Boolean(m.is_reasoning ?? m.reasoning ?? false),
        supportsEffort: Boolean(m.supports_effort ?? m.supportsEffort ?? false),
        input: Array.isArray(m.input)
          ? (m.input as Array<"text" | "image">)
          : m.support_image
            ? ["text", "image"]
            : ["text"],
        source: String(m.source || "system"),
      })
    );
  }
  return out;
}

async function listModelsForMode(
  mode: QoderMode,
  credentials?: QoderCredentials
): Promise<ModelInfo[]> {
  const creds = credentials || getCredentials(mode);
  if (!creds && !credentials) {
    // Not logged in: still expose static catalog so UI can show both sides
    return staticModels(mode);
  }
  try {
    const res = await qoderFetch({
      method: "GET",
      url: urls(mode).modelList,
      encode: false,
      bearer: false,
      mode,
      credentials: creds || undefined,
      headers: { Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (parsed && typeof parsed === "object" && "body" in (parsed as object)) {
      const body = (parsed as { body: unknown }).body;
      parsed = typeof body === "string" ? JSON.parse(body) : body;
    }
    const models = normalizeModelList(parsed, mode);
    if (models.length > 0) return models;
  } catch {
    /* fall back */
  }
  return staticModels(mode);
}

export async function listModels(options?: {
  mode?: ModeFilter | QoderMode | string | null;
  credentials?: QoderCredentials;
}): Promise<ModelInfo[]> {
  const raw = String(options?.mode ?? "all").toLowerCase();
  if (raw === "all" || raw === "both" || raw === "*") {
    const [cn, global] = await Promise.all([
      listModelsForMode("cn"),
      listModelsForMode("global"),
    ]);
    return [...cn, ...global];
  }
  const mode = resolveMode(raw);
  return listModelsForMode(mode, options?.credentials);
}

export function getModelConfig(
  modelId: string,
  models: ModelInfo[],
  mode?: QoderMode
): { key: string; is_reasoning: boolean; max_output_tokens: number; source: string; mode: QoderMode; localId: string } {
  const hit =
    models.find((x) => x.id === modelId) ||
    models.find((x) => mode && x.mode === mode && (x.localId === modelId || x.key === modelId)) ||
    models.find((x) => x.localId === modelId || x.key === modelId);

  const resolvedMode = hit?.mode || (mode ? resolveMode(mode) : "cn");
  const key = hit?.key || modelId || "auto";
  return {
    key,
    is_reasoning: hit?.reasoning ?? /ultimate|performance|dmodel|reasoning/i.test(key),
    max_output_tokens: hit?.maxTokens || 32768,
    source: hit?.source || "system",
    mode: resolvedMode,
    localId: hit?.localId || modelId,
  };
}
