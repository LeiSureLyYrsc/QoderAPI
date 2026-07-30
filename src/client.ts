import { login } from "./auth/login.js";
import { clearCredentials, getCredentials, saveCredentials } from "./auth/store.js";
import { chat, chatStream } from "./api/chat.js";
import { listModels } from "./api/models.js";
import { getUsage } from "./api/usage.js";
import { resolveMode } from "./config/endpoints.js";
import type {
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  LoginOptions,
  ModelInfo,
  QoderCredentials,
  QoderMode,
  UsageInfo,
} from "./types.js";

export interface QoderClientOptions {
  mode?: QoderMode;
  credentials?: QoderCredentials;
}

export class QoderClient {
  mode: QoderMode;
  credentials: QoderCredentials | null;

  constructor(options: QoderClientOptions = {}) {
    this.mode = resolveMode(options.mode);
    this.credentials = options.credentials || getCredentials(this.mode);
  }

  async login(options: LoginOptions = {}): Promise<QoderCredentials> {
    const creds = await login({ ...options, mode: options.mode || this.mode });
    this.mode = creds.mode;
    this.credentials = creds;
    return creds;
  }

  logout(): void {
    clearCredentials(this.mode);
    this.credentials = null;
  }

  getAuth(): QoderCredentials | null {
    return this.credentials || getCredentials(this.mode);
  }

  async listModels(all = true): Promise<ModelInfo[]> {
    return listModels({
      mode: all ? "all" : this.mode,
      credentials: all ? undefined : this.getAuth() || undefined,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    return chat(req, {
      defaultMode: this.mode,
      mode: req.mode,
      credentials: this.getAuth() || undefined,
    });
  }

  chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    return chatStream(req, {
      defaultMode: this.mode,
      mode: req.mode,
      credentials: this.getAuth() || undefined,
    });
  }

  async usage(): Promise<UsageInfo> {
    return getUsage({ mode: this.mode, credentials: this.getAuth() || undefined });
  }

  setCredentials(creds: QoderCredentials): void {
    this.credentials = creds;
    this.mode = creds.mode;
    saveCredentials(creds);
  }
}
