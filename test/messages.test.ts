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

  it("expands OpenCode tool-call / tool-result parts", () => {
    const out = normalizeConversation([
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking up" },
          {
            type: "tool-call",
            toolCallId: "webfetch_1",
            toolName: "webfetch",
            input: { url: "https://github.com/LeiSureLyYrsc" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "webfetch_1",
            toolName: "webfetch",
            output: { type: "text", value: "profile html" },
          },
        ],
      },
    ] as never);
    assert.equal(out[1]?.role, "assistant");
    assert.equal(out[1]?.tool_calls?.[0]?.id, "webfetch_1");
    assert.equal(out[1]?.tool_calls?.[0]?.function.name, "webfetch");
    assert.equal(out[2]?.role, "tool");
    assert.equal(out[2]?.tool_call_id, "webfetch_1");
    assert.match(String(out[2]?.content), /profile html/);
  });

  it("inserts tool_calls before a later tool group after a reminder assistant", () => {
    const out = normalizeConversation([
      { role: "user", content: "搜索LeiSureLyYrsc是谁" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "searching" },
          {
            type: "tool-call",
            toolCallId: "webfetch_1",
            toolName: "webfetch",
            input: { url: "https://github.com/LeiSureLyYrsc" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "webfetch_1",
            output: "github html",
          },
        ],
      },
      {
        role: "assistant",
        content: "<system-reminder>Plan mode is still active.</system-reminder>",
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "bash_1",
            toolName: "bash",
            output: '{"login":"LeiSureLyYrsc"}',
          },
        ],
      },
    ] as never);

    for (let i = 0; i < out.length; i++) {
      if (out[i]?.role === "tool") {
        const prev = out[i - 1];
        assert.equal(prev?.role, "assistant");
        assert.ok(prev?.tool_calls?.length);
      }
    }
    const bashTool = out.find(
      (m) => m.role === "tool" && m.tool_call_id === "bash_1"
    );
    assert.ok(bashTool);
    const bashIdx = out.indexOf(bashTool!);
    assert.equal(out[bashIdx - 1]?.tool_calls?.[0]?.id, "bash_1");
  });
});
