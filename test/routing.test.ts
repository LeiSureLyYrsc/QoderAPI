import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseModelRef,
  publicModelId,
  resolveModelRoute,
  gatewayKeyFor,
} from "../src/config/routing.ts";

describe("parseModelRef", () => {
  it("parses cn/ and global/ prefixes", () => {
    assert.deepEqual(parseModelRef("cn/auto"), {
      mode: "cn",
      bareId: "auto",
      raw: "cn/auto",
    });
    assert.equal(parseModelRef("global/lite").mode, "global");
    assert.equal(parseModelRef("global/lite").bareId, "lite");
    assert.equal(parseModelRef("cn:qwen3.7-max").mode, "cn");
    assert.equal(parseModelRef("g/ultimate").mode, "global");
  });

  it("leaves bare ids without mode", () => {
    const p = parseModelRef("auto");
    assert.equal(p.mode, undefined);
    assert.equal(p.bareId, "auto");
  });
});

describe("gatewayKeyFor", () => {
  it("maps CN friendly names", () => {
    assert.equal(gatewayKeyFor("qwen3.7-max", "cn"), "qmodel_latest");
    assert.equal(gatewayKeyFor("auto", "cn"), "auto");
  });

  it("keeps global tier names", () => {
    assert.equal(gatewayKeyFor("ultimate", "global"), "ultimate");
    assert.equal(gatewayKeyFor("lite", "global"), "lite");
  });
});

describe("resolveModelRoute", () => {
  it("uses explicit prefix", () => {
    const r = resolveModelRoute("cn/qwen3.7-plus", { defaultMode: "global" });
    assert.equal(r.mode, "cn");
    assert.equal(r.key, "qmodel");
    assert.equal(r.publicId, "cn/qwen3.7-plus");
  });

  it("infers CN-only bare ids", () => {
    const r = resolveModelRoute("qwen3.6-flash", { defaultMode: "global" });
    assert.equal(r.mode, "cn");
    const r2 = resolveModelRoute("qwen3.7-flash", { defaultMode: "global" });
    assert.equal(r2.mode, "cn");
    const r3 = resolveModelRoute("glm-5.3", { defaultMode: "global" });
    assert.equal(r3.mode, "cn");
  });

  it("infers Global-only bare ids", () => {
    const r = resolveModelRoute("ultimate", { defaultMode: "cn" });
    assert.equal(r.mode, "global");
  });

  it("forceMode overrides prefix bare id only", () => {
    const r = resolveModelRoute("auto", { forceMode: "global" });
    assert.equal(r.mode, "global");
    assert.equal(r.publicId, "global/auto");
  });
});

describe("publicModelId", () => {
  it("formats", () => {
    assert.equal(publicModelId("cn", "auto"), "cn/auto");
    assert.equal(publicModelId("global", "lite"), "global/lite");
  });
});
