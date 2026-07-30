import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { qoderDecodeBody, qoderEncodeBody } from "../src/crypto/encode.ts";
import { computeSigPath } from "../src/crypto/cosy.ts";

describe("qoderEncodeBody", () => {
  it("round-trips JSON payloads", () => {
    const samples = [
      "{}",
      '{"a":1}',
      JSON.stringify({ hello: "world", n: 42, arr: [1, 2, 3] }),
      "x".repeat(1000),
    ];
    for (const s of samples) {
      const enc = qoderEncodeBody(s);
      assert.equal(typeof enc, "string");
      assert.ok(enc.length > 0);
      assert.equal(enc.includes("="), false);
      const dec = qoderDecodeBody(enc).toString("utf8");
      assert.equal(dec, s);
    }
  });

  it("uses custom alphabet characters", () => {
    const enc = qoderEncodeBody('{"test":true}');
    assert.match(enc, /[_@#&*%^().!,]/);
  });
});

describe("computeSigPath", () => {
  it("strips /algo prefix", () => {
    assert.equal(
      computeSigPath(
        "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1"
      ),
      "/api/v2/service/pro/sse/agent_chat_generation"
    );
  });

  it("keeps non-algo paths", () => {
    assert.equal(
      computeSigPath("https://openapi.qoder.com.cn/api/v1/userinfo"),
      "/api/v1/userinfo"
    );
  });
});
