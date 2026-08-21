import type { QoderMode } from "../types.js";

export const COSY_VERSION = "1.1.3";
export const COSY_CLIENT_TYPE = "5";
export const COSY_DATA_POLICY = "disagree";
export const COSY_LOGIN_VERSION = "v2";
export const COSY_MACHINE_TYPE = "5";
export const CLIENT_PRODUCT_VERSION = "1.0.0";
export const USER_AGENT = `qoder-reserve/${CLIENT_PRODUCT_VERSION}`;

export function resolveMode(mode?: string | null): QoderMode {
  const m = String(mode || process.env.QODER_REGION || process.env.QODER_BACKEND || process.env.QODER_MODE || "")
    .trim()
    .toLowerCase();
  if (["cn", "china", "qodercn", "qoder-cn", "qoderclicn"].includes(m)) return "cn";
  if (["global", "intl", "international", "qoder", "qodercli"].includes(m)) return "global";

  const hasCnPat = Boolean(
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN ||
      process.env.QODERCN_PAT ||
      process.env.QODERCN_API_KEY
  );
  const hasGlobalPat = Boolean(
    process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT || process.env.QODER_API_KEY
  );
  if (hasCnPat && !hasGlobalPat) return "cn";
  return "global";
}

export function isCn(mode?: QoderMode | string | null): boolean {
  return resolveMode(mode) === "cn";
}

export function openApiBase(mode?: QoderMode | string | null): string {
  return isCn(mode) ? "https://openapi.qoder.com.cn" : "https://openapi.qoder.sh";
}

export function gatewayBase(mode?: QoderMode | string | null): string {
  return isCn(mode) ? "https://gateway.qoder.com.cn" : "https://api3.qoder.sh";
}

export function centerBase(mode?: QoderMode | string | null): string {
  return isCn(mode) ? "https://gateway.qoder.com.cn" : "https://center.qoder.sh";
}

export function manageUrl(mode?: QoderMode | string | null): string {
  return isCn(mode) ? "https://qoder.com.cn" : "https://qoder.com";
}

export function patSettingsUrl(mode?: QoderMode | string | null): string {
  return `${manageUrl(mode)}/account/integrations`;
}

export function deviceLoginUrl(mode?: QoderMode | string | null): string {
  // CN device page may or may not exist; callers should fall back to PAT.
  return isCn(mode)
    ? "https://qoder.com.cn/device/selectAccounts"
    : "https://qoder.com/device/selectAccounts";
}

export function urls(mode?: QoderMode | string | null) {
  const openapi = openApiBase(mode);
  const gateway = gatewayBase(mode);
  const center = centerBase(mode);
  return {
    openapi,
    gateway,
    center,
    exchange: `${openapi}/api/v1/jobToken/exchange`,
    jobTokenRefresh: `${openapi}/api/v1/jobToken/refresh`,
    devicePoll: `${openapi}/api/v1/deviceToken/poll`,
    deviceRefresh: `${openapi}/api/v1/deviceToken/refresh`,
    userinfo: `${openapi}/api/v1/userinfo`,
    usage: `${openapi}/api/v2/quota/usage`,
    modelList: `${gateway}/algo/api/v2/model/list?Encode=1`,
    chat: `${gateway}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
    refreshToken: `${center}/algo/api/v3/user/refresh_token`,
    deviceWeb: deviceLoginUrl(mode),
    manage: manageUrl(mode),
    patSettings: patSettingsUrl(mode),
  };
}

/** Friendly CN model ids → internal gateway keys. */
export const CN_MODEL_ALIASES: Record<string, string> = {
  "qoder-cn": "auto",
  auto: "auto",
  "qwen3.8-max": "qmodel_preview",
  "qwen3.8-max-preview": "qmodel_preview",
  "qwen3.7-max": "qmodel_latest",
  "qwen3.7-plus": "qmodel",
  "qwen3.6-plus": "qmodel",
  "qwen3.7-flash": "qfmodel",
  "qwen3.6-flash": "q36fmodel",
  "deepseek-v4-pro": "dmodel",
  "deepseek-v4-flash": "dfmodel",
  "glm-5.3": "gm53model",
  "glm-5.2": "gm51model",
  "glm-5.1": "gm51model",
  "kimi-k2.7-code": "kmodel",
  "kimi-k2.6": "kmodel",
  "minimax-m2.7": "mmodel",
  "minimax-m3": "mmodel",
};

export const CN_KEY_TO_FRIENDLY: Record<string, { id: string; name: string }> = {
  auto: { id: "auto", name: "Auto · Qoder CN" },
  qmodel_preview: { id: "qwen3.8-max", name: "Qwen 3.8 Max · Qoder CN" },
  qmodel_latest: { id: "qwen3.7-max", name: "Qwen 3.7 Max · Qoder CN" },
  qmodel: { id: "qwen3.7-plus", name: "Qwen 3.7 Plus · Qoder CN" },
  qfmodel: { id: "qwen3.7-flash", name: "Qwen 3.7 Flash · Qoder CN" },
  q36fmodel: { id: "qwen3.7-flash", name: "Qwen 3.7 Flash · Qoder CN" },
  dmodel: { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro · Qoder CN" },
  dfmodel: { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash · Qoder CN" },
  gm53model: { id: "glm-5.3", name: "GLM 5.3 · Qoder CN" },
  gm51model: { id: "glm-5.2", name: "GLM 5.2 · Qoder CN" },
  kmodel: { id: "kimi-k2.7-code", name: "Kimi K2.7 Code · Qoder CN" },
  mmodel: { id: "minimax-m2.7", name: "MiniMax M2.7 · Qoder CN" },
};

export function resolveModelKey(modelId: string, mode?: QoderMode | string | null): string {
  const id = String(modelId || "auto").trim();
  if (isCn(mode)) return CN_MODEL_ALIASES[id] || id;
  return id;
}

export function machineOs(): string {
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows";
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64_darwin" : "x86_64_darwin";
  }
  return process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
}
