export type QoderMode = "cn" | "global";

/** Global account capability tier (user-marked). */
export type GlobalTier = "pro" | "only_ultimate";

export type AccountStatus = "active" | "rate_limited" | "exhausted" | "disabled";

export interface QoderCredentials {
  mode: QoderMode;
  /** Short-lived job/device token used as Bearer for OpenAPI and COSY. */
  access: string;
  /** Opaque refresh payload. PAT form: `pat|pt-...|jobRefresh|userID|machineID` */
  refresh: string;
  /** Epoch ms when access should be treated as expired (with buffer). */
  expires: number;
  userID: string;
  email: string;
  name: string;
  machineID: string;
  /** Original PAT if login was via personal access token. */
  pat?: string;
  /** Pool account id when selected from the account pool. */
  accountId?: string;
}

/**
 * Multi-account pool entry. CN and Global both support many accounts.
 * Global accounts may be marked pro (all models) or only_ultimate.
 */
export interface PoolAccount {
  id: string;
  name: string;
  mode: QoderMode;
  /** Only meaningful for mode=global. Default pro. */
  globalTier: GlobalTier;
  status: AccountStatus;
  rateLimitUntil: number | null;
  errorCount: number;
  addedAt: number;
  lastUsedAt?: number;
  access: string;
  refresh: string;
  expires: number;
  userID: string;
  email: string;
  /** Display name from provider profile. */
  profileName: string;
  machineID: string;
  pat?: string;
}

export type PoolErrorType = "rate_limit" | "quota_exhausted" | "auth_error";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ContentPart {
  type: "text" | "image_url" | "tool_use" | "tool_result" | "function" | "tool";
  text?: string;
  image_url?: { url: string };
  id?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  tool_use_id?: string;
  tool_call_id?: string;
  content?: unknown;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ModelInfo {
  /** Public id, e.g. cn/auto or global/lite */
  id: string;
  /** Site-local bare id, e.g. auto */
  localId: string;
  name: string;
  key: string;
  mode: QoderMode;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  supportsEffort: boolean;
  input: Array<"text" | "image">;
  source?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  stream?: boolean;
  sessionId?: string;
  temperature?: number;
  /** Optional explicit site; model prefix still wins when present. */
  mode?: QoderMode;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface ChatChoiceDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      arguments?: string;
    }
  | {
      type: "tool_call";
      index: number;
      id: string;
      name: string;
      arguments: string;
    }
  | { type: "usage"; usage: ChatUsage }
  | { type: "finish"; reason: string }
  | { type: "error"; error: string };

export interface ChatResult {
  id: string;
  model: string;
  content: string;
  reasoning?: string;
  tool_calls: ToolCall[];
  finish_reason: string;
  usage: ChatUsage;
}

export interface UsageInfo {
  summary: string;
  raw: unknown;
  buckets: Array<{
    id: string;
    label: string;
    used: number;
    total: number;
    remaining?: number;
    unit?: string;
    resetAt?: string;
  }>;
}

export interface LoginOptions {
  mode?: QoderMode;
  pat?: string;
  /** Open browser automatically for device flow. Default true. */
  openBrowser?: boolean;
  onProgress?: (message: string) => void;
  onAuthUrl?: (url: string) => void;
  signal?: AbortSignal;
}
