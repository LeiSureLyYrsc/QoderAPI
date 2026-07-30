/**
 * Compatibility facade over the multi-account pool.
 * Prefer importing from ./pool.js for new code.
 */
export {
  listAccounts,
  getAccount,
  addAccount,
  updateAccount,
  removeAccount,
  getNextAvailable,
  countAvailable,
  getAvailableAccounts,
  reportError,
  publicAccount,
  poolSummary,
  accountToCredentials,
  getCredentials,
  saveCredentials,
  clearCredentials,
  loadAuthStore,
  ensureMigrated,
  canServeModel,
  isUltimateModel,
  classifyProviderError,
} from "./pool.js";

export type { AuthStore } from "./pool.js";
