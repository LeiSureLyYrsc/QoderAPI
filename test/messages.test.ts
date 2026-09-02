import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeConversation } from "../src/api/messages.ts";

describe("normalizeConversation", () => {
  it("keeps OpenAI assistant tool_calls + tool results", () => {
    const out = normalizeConversation([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: "{\"path\":\"a.ts\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ]);
    assert.equal(out[1]?.role, "assistant");
    assert.equal(out[1]?.tool_calls?.[0]?.id, "call_1");
    assert.equal(out[2]?.role, "tool");
    assert.equal(out[2]?.tool_call_id, "call_1");
  });

  it("expands Anthropic tool_use / tool_result parts", () => {
    const out = normalizeConversation([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "tu_1", name: "ls", input: { dir: "." } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "a.ts" }],
      },
    ] as never);
    assert.equal(out[1]?.role, "assistant");
    assert.equal(out[1]?.content, "checking");
    assert.equal(out[1]?.tool_calls?.[0]?.id, "tu_1");
    assert.equal(out[1]?.tool_calls?.[0]?.function.name, "ls");
    assert.equal(out[2]?.role, "tool");
    assert.equal(out[2]?.tool_call_id, "tu_1");
    assert.equal(out[2]?.content, "a.ts");
  });

  it("synthesizes assistant tool_calls for orphan tool results", () => {
    const out = normalizeConversation([
      { role: "user", content: "go" },
      { role: "tool", tool_call_id: "orphan_1", content: "result" },
    ]);
    assert.equal(out[1]?.role, "assistant");
    assert.equal(out[1]?.tool_calls?.[0]?.id, "orphan_1");
    assert.equal(out[2]?.role, "tool");
    assert.equal(out[2]?.tool_call_id, "orphan_1");
  });

  it("maps function role and toolCallId aliases", () => {
    const out = normalizeConversation([
      {
        role: "assistant",
        content: null as never,
        tool_calls: [
          { id: "x", type: "function", function: { name: "fn", arguments: "{}" } },
        ],
      },
      { role: "function" as never, toolCallId: "x", content: "done" } as never,
    ]);
    assert.equal(out[1]?.role, "tool");
    assert.equal(out[1]?.tool_call_id, "x");
  });
});
