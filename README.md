# qoder-reserve1

Standalone **Qoder CN / Global** API client with **multi-account pool**. No `qoderclicn` binary.

Implements:

- **Account pool** (CN + Global): round-robin, 429 freeze, quota/auth failover
- **Global tiers** (user-marked): `pro` (all models) vs `only_ultimate` (only `global/ultimate`)
- PAT → jobToken / Device PKCE / official credential import
- COSY + `Encode=1`, streaming chat, model list, usage
- WebUI + OpenAI-compatible proxy on `127.0.0.1`

> Personal protocol-adaptation research for **your own** account only. Do not deploy as a public relay, share tokens, or bypass billing/limits.

## Install

```bash
cd D:\Desktop\QoderReserve
npm install
npm run build
```

## Quick start

### 1. Account pool

```bash
# CN
npx tsx src/cli.ts accounts add --mode cn --pat pt-... --name work-cn

# Global Pro (all models from qodercli --list-models)
npx tsx src/cli.ts accounts add --mode global --pat pt-... --tier pro --name pro-1

# Global Only Ultimate (only global/ultimate)
npx tsx src/cli.ts accounts add --mode global --pat pt-... --tier only_ultimate --name ult-1

npx tsx src/cli.ts accounts list
npx tsx src/cli.ts accounts set <id> --tier only_ultimate
```

`login` / WebUI「添加账号」都会**追加**到号池，不再覆盖单账号。

Only Ultimate 不会被调度去跑 `global/auto`、`global/lite` 等 Pro 模型。

### 2. Use API

```bash
npx tsx src/cli.ts models --mode cn
npx tsx src/cli.ts usage --mode cn
npx tsx src/cli.ts chat --mode cn --model auto "用一句话介绍你自己"
npx tsx src/cli.ts chat --mode cn --stream --model auto "hi"
```

### 3. WebUI + OpenAI proxy

```bash
npx tsx src/cli.ts serve --mode cn --port 3927 --open
# or: npm run ui
```

Open **http://127.0.0.1:3927/ui/** for the console:

- **CN + Global 并行**：两边可同时登录，不必先选 region
- 模型 ID 带前缀：`cn/auto`、`global/lite` —— **选模型即选站点**
- 账号双栏登录（PAT / Device / 导入官方凭据）
- 合并模型列表、双端用量、流式对话
- OpenAI 兼容代理；主题 / 默认模型 / PROXY_API_KEY

```bash
curl http://127.0.0.1:3927/v1/models
# CN
curl http://127.0.0.1:3927/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"cn/auto\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
# Global
curl http://127.0.0.1:3927/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"global/lite\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```

Optional: set `PROXY_API_KEY` or `--api-key`（只保护 `/v1/*`；本机 `/ui` 与 `/api` 默认开放）。

顶栏「默认」仅影响**无前缀**模型 id 的回退；推荐始终使用 `cn/...` / `global/...`。

## Library

```ts
import { QoderClient } from "qoder-reserve";

const client = new QoderClient({ mode: "cn" });
await client.login({ pat: process.env.QODERCN_PERSONAL_ACCESS_TOKEN });
const models = await client.listModels();
const res = await client.chat({
  model: "auto",
  messages: [{ role: "user", content: "hello" }],
});
console.log(res.content);
```

## Credentials storage

`~/.qoder-reserve/auth.json` (override with `QODER_RESERVE_CONFIG_DIR`)

## Endpoints

| | CN | Global |
|--|----|--------|
| OpenAPI | `openapi.qoder.com.cn` | `openapi.qoder.sh` |
| Gateway | `gateway.qoder.com.cn` | `api3.qoder.sh` |
| Chat | `/algo/api/v2/service/pro/sse/agent_chat_generation?...&Encode=1` | same path |

## What this is not

Not a full CLI agent runtime (no local Bash/Read/Write loop, MCP host, plugins UI). It exposes the **cloud model API** so other tools can call Qoder without the official binary.

## Tests

```bash
npm test
```

## License

MIT
