#!/usr/bin/env node
import { login, loginToPool } from "./auth/login.js";
import {
  addAccount,
  clearCredentials,
  listAccounts,
  poolSummary,
  publicAccount,
  removeAccount,
  updateAccount,
} from "./auth/pool.js";
import { accountsFilePath } from "./auth/paths.js";
import fs from "node:fs";
import { chat, chatStream } from "./api/chat.js";
import { listModels } from "./api/models.js";
import { getUsage } from "./api/usage.js";
import { resolveMode, urls } from "./config/endpoints.js";
import { startOpenAIServer } from "./openai/server.js";
import type { GlobalTier, QoderMode } from "./types.js";
import { importOfficialCredentials } from "./auth/import-official.js";

function printHelp(): void {
  console.log(`qoder-reserve — standalone Qoder CN/Global API client (account pool)

Usage:
  qoder-reserve accounts list
  qoder-reserve accounts add --mode cn|global --pat pt-... [--name x] [--tier pro|only_ultimate]
  qoder-reserve accounts set <id> --tier only_ultimate|--name x|--status active|disabled
  qoder-reserve accounts rm <id>
  qoder-reserve accounts export [--file path] [--mask]
  qoder-reserve accounts import --file path
  qoder-reserve login [--mode cn|global] [--pat pt-...] [--tier pro|only_ultimate]
      (adds a pool account)
  qoder-reserve logout [--mode cn|global] | --all
  qoder-reserve status
  qoder-reserve import-official [--mode cn|global] [--tier pro|only_ultimate]
  qoder-reserve models [--mode cn|global|all]
  qoder-reserve usage [--mode cn|global|all]
  qoder-reserve chat [--model cn/auto|global/ultimate] [--stream] <prompt...>
  qoder-reserve serve [--port 3927] [--api-key <key>] [--open]
      WebUI: http://127.0.0.1:<port>/ui/
      Global Only Ultimate accounts only serve global/ultimate

Env:
  QODERCN_PERSONAL_ACCESS_TOKEN / QODER_PERSONAL_ACCESS_TOKEN
  QODER_REGION=cn|global
  QODER_RESERVE_CONFIG_DIR
  PROXY_API_KEY
  NO_BROWSER=1
`);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const command = args[0] || "help";
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--stream") {
      flags.stream = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, flags, positional };
}

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv);
  const mode = resolveMode(
    typeof flags.mode === "string" ? flags.mode : undefined
  ) as QoderMode;

  switch (command) {
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return;

    case "accounts": {
      const sub = positional[0] || "list";
      if (sub === "list") {
        console.log(JSON.stringify({ summary: poolSummary(), accounts: listAccounts().map(publicAccount) }, null, 2));
        return;
      }
      if (sub === "add") {
        const pat = typeof flags.pat === "string" ? flags.pat : undefined;
        if (!pat && !flags.mode) {
          console.error("accounts add requires --mode and usually --pat");
          process.exitCode = 1;
          return;
        }
        const tier = typeof flags.tier === "string" ? flags.tier : undefined;
        const name = typeof flags.name === "string" ? flags.name : undefined;
        const acc = await loginToPool({
          mode,
          pat,
          name,
          globalTier: tier as GlobalTier | undefined,
          onProgress: (m) => console.error(`[accounts] ${m}`),
          onAuthUrl: (url) => console.error(`[accounts] Open:\n${url}`),
        });
        console.log(JSON.stringify(publicAccount(acc), null, 2));
        return;
      }
      if (sub === "set") {
        const id = positional[1];
        if (!id) {
          console.error("accounts set <id> --tier|--name|--status");
          process.exitCode = 1;
          return;
        }
        const patch: Parameters<typeof updateAccount>[1] = {};
        if (typeof flags.tier === "string") patch.globalTier = flags.tier as GlobalTier;
        if (typeof flags.name === "string") patch.name = flags.name;
        if (typeof flags.status === "string") {
          patch.status = flags.status as "active" | "disabled";
          if (flags.status === "active") patch.rateLimitUntil = null;
        }
        const acc = updateAccount(id, patch);
        if (!acc) {
          console.error("account not found");
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(publicAccount(acc), null, 2));
        return;
      }
      if (sub === "rm" || sub === "remove") {
        const id = positional[1];
        if (!id || !removeAccount(id)) {
          console.error("account not found");
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, id }, null, 2));
        return;
      }
      if (sub === "export") {
        const file = (typeof flags.file === "string" ? flags.file : undefined) || positional[1];
        const mask = Boolean(flags.mask);
        const raw = JSON.parse(fs.readFileSync(accountsFilePath(), "utf8")) as object[];
        if (mask) {
          for (const a of raw as Record<string, unknown>[]) {
            if (a.access) a.access = (String(a.access)).slice(0, 4) + "***";
            if (a.refresh) a.refresh = "***";
            if (a.pat) a.pat = (String(a.pat)).slice(0, 6) + "***";
          }
        }
        const json = JSON.stringify(raw, null, 2);
        if (file) {
          fs.writeFileSync(file, json, "utf8");
          console.log(`Exported ${raw.length} accounts to ${file}${mask ? " (masked)" : ""}`);
        } else {
          console.log(json);
        }
        return;
      }
      if (sub === "import") {
        const file = (typeof flags.file === "string" ? flags.file : undefined) || positional[1];
        if (!file) {
          console.error("accounts import --file <path>");
          process.exitCode = 1;
          return;
        }
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>[];
        if (!Array.isArray(raw) || !raw.length) {
          console.error("file must be a non-empty JSON array of accounts");
          process.exitCode = 1;
          return;
        }
        // Merge: skip entries whose id already exists in pool
        const existing = new Set(listAccounts().map((a) => a.id));
        const merged: Record<string, unknown>[] = [];
        for (const entry of raw) {
          const id = String(entry.id || "");
          if (id && existing.has(id)) {
            console.error(`Skipping duplicate id: ${id.slice(0, 8)}…`);
            continue;
          }
          merged.push(entry);
        }
        if (!merged.length) {
          console.error("No new accounts to import (all ids already in pool)");
          process.exitCode = 1;
          return;
        }
        const current = JSON.parse(fs.readFileSync(accountsFilePath(), "utf8")) as object[];
        current.push(...merged);
        fs.writeFileSync(accountsFilePath(), JSON.stringify(current, null, 2), { encoding: "utf8", mode: 0o600 });
        console.log(`Imported ${merged.length} accounts (pool now has ${current.length})`);
        return;
      }
      console.error(`Unknown accounts subcommand: ${sub}`);
      process.exitCode = 1;
      return;
    }

    case "login": {
      const pat = typeof flags.pat === "string" ? flags.pat : undefined;
      const tier = typeof flags.tier === "string" ? flags.tier : undefined;
      const name = typeof flags.name === "string" ? flags.name : undefined;
      const acc = await loginToPool({
        mode,
        pat,
        name,
        globalTier: tier as GlobalTier | undefined,
        onProgress: (m) => console.error(`[login] ${m}`),
        onAuthUrl: (url) => {
          console.error(`[login] Open this URL:\n${url}`);
        },
      });
      console.log(JSON.stringify(publicAccount(acc), null, 2));
      return;
    }

    case "logout": {
      if (flags.all) {
        clearCredentials();
        console.log("Cleared entire account pool");
      } else if (flags.mode) {
        clearCredentials(mode);
        console.log(`Removed all ${mode} accounts from pool`);
      } else {
        clearCredentials();
        console.log("Cleared entire account pool (use --mode cn|global to clear one site)");
      }
      return;
    }

    case "status": {
      console.log(
        JSON.stringify(
          {
            summary: poolSummary(),
            accounts: listAccounts().map(publicAccount),
            endpoints: { cn: urls("cn"), global: urls("global") },
          },
          null,
          2
        )
      );
      return;
    }

    case "import-official": {
      const result = await importOfficialCredentials(mode);
      if (!result.ok || !result.credentials) {
        console.error(result.error || "Import failed");
        process.exitCode = 1;
        return;
      }
      const tier = typeof flags.tier === "string" ? flags.tier : undefined;
      const acc = addAccount({
        mode,
        credentials: result.credentials,
        globalTier: tier as GlobalTier | undefined,
        name: typeof flags.name === "string" ? flags.name : undefined,
      });
      console.log(JSON.stringify({ method: result.method, account: publicAccount(acc) }, null, 2));
      return;
    }

    case "models": {
      const filter =
        typeof flags.mode === "string" ? String(flags.mode) : "all";
      const models = await listModels({ mode: filter });
      for (const m of models) {
        console.log(
          `${String(m.mode).padEnd(7)} ${m.id.padEnd(28)} key=${m.key.padEnd(16)} ctx=${m.contextWindow} reason=${m.reasoning ? "Y" : "N"}  ${m.name}`
        );
      }
      return;
    }

    case "usage": {
      const filter =
        typeof flags.mode === "string" ? String(flags.mode) : "all";
      if (filter === "all" || filter === "both") {
        const { getUsageAll } = await import("./api/usage.js");
        console.log(JSON.stringify(await getUsageAll(), null, 2));
        return;
      }
      const usage = await getUsage({ mode });
      console.log(usage.summary);
      console.log(JSON.stringify(usage.buckets, null, 2));
      return;
    }

    case "chat": {
      const prompt = positional.join(" ").trim();
      if (!prompt) {
        console.error("Usage: qoder-reserve chat [--model cn/auto] <prompt>");
        process.exitCode = 1;
        return;
      }
      const model =
        typeof flags.model === "string"
          ? flags.model
          : mode === "global"
            ? "global/auto"
            : "cn/auto";

      if (flags.stream) {
        for await (const ev of chatStream(
          { model, messages: [{ role: "user", content: prompt }], stream: true },
          { defaultMode: mode }
        )) {
          if (ev.type === "text") process.stdout.write(ev.text);
          else if (ev.type === "reasoning") process.stderr.write(`\x1b[90m${ev.text}\x1b[0m`);
          else if (ev.type === "error") {
            console.error("\n" + ev.error);
            process.exitCode = 1;
          } else if (ev.type === "finish") {
            process.stdout.write("\n");
          }
        }
        return;
      }

      const result = await chat(
        { model, messages: [{ role: "user", content: prompt }] },
        { defaultMode: mode }
      );
      if (result.reasoning) console.error(`[reasoning]\n${result.reasoning}\n`);
      console.log(result.content);
      if (result.tool_calls.length) {
        console.error("[tool_calls]", JSON.stringify(result.tool_calls, null, 2));
      }
      return;
    }

    case "serve": {
      const port =
        typeof flags.port === "string" ? Number(flags.port) : Number(process.env.PORT || 3927);
      const apiKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
      const openBrowser = Boolean(flags.open);
      startOpenAIServer({ mode, port, apiKey, openBrowser });
      return;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
