export { QoderClient } from "./client.js";
export type { QoderClientOptions } from "./client.js";

export { login, loginWithPat } from "./auth/login.js";
export { runDeviceFlow } from "./auth/device.js";
export { credentialsFromPat, exchangeJobToken, envPat } from "./auth/pat.js";
export { importOfficialCredentials } from "./auth/import-official.js";
export {
  getCredentials,
  saveCredentials,
  clearCredentials,
  loadAuthStore,
  listAccounts,
  addAccount,
  updateAccount,
  removeAccount,
  getNextAvailable,
  getAccountForSession,
  poolSummary,
  publicAccount,
} from "./auth/store.js";
export { refreshCredentials, ensureFresh } from "./auth/refresh.js";

export { chat, chatStream } from "./api/chat.js";
export { listModels } from "./api/models.js";
export { getUsage, getUsageAll } from "./api/usage.js";
export { qoderFetch, qoderFetchJson, resolveCredentials, QoderHttpError } from "./api/client.js";

export { qoderEncodeBody, qoderDecodeBody } from "./crypto/encode.js";
export { buildAuthHeaders, computeSigPath, QODER_RSA_PUBLIC_KEY } from "./crypto/cosy.js";
export { getMachineId } from "./crypto/machine-id.js";

export {
  resolveMode,
  urls,
  resolveModelKey,
  CN_MODEL_ALIASES,
} from "./config/endpoints.js";
export { resolveModelRoute, parseModelRef, publicModelId } from "./config/routing.js";

export { startOpenAIServer } from "./openai/server.js";
export type { OpenAIServerOptions } from "./openai/server.js";
export { handleApi } from "./web/api.js";

export type * from "./types.js";
