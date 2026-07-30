import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addAccount,
  canServeModel,
  countAvailable,
  getNextAvailable,
  isUltimateModel,
  listAccounts,
  reportError,
  updateAccount,
} from "../src/auth/pool.ts";
import type { QoderCredentials } from "../src/types.ts";
import { resolveModelRoute } from "../src/config/routing.ts";

function creds(mode: "cn" | "global", userID: string): QoderCredentials {
  return {
    mode,
    access: `tok-${userID}`,
    refresh: "r",
    expires: Date.now() + 3600_000,
    userID,
    email: `${userID}@t.test`,
    name: userID,
    machineID: "m",
    pat: `pt-${userID}`,
  };
}

describe("pool ultimate filter", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qr-pool-"));
    prev = process.env.QODER_RESERVE_CONFIG_DIR;
    process.env.QODER_RESERVE_CONFIG_DIR = dir;
    // reset module migration flag by writing empty accounts
    fs.writeFileSync(path.join(dir, "accounts.json"), "[]");
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.QODER_RESERVE_CONFIG_DIR;
    else process.env.QODER_RESERVE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("isUltimateModel normalizes ids", () => {
    assert.equal(isUltimateModel({ bareId: "ultimate", key: "x" }), true);
    assert.equal(isUltimateModel({ bareId: "Ultimate", key: "auto" }), true);
    assert.equal(isUltimateModel({ bareId: "auto", key: "ultimate" }), true);
    assert.equal(isUltimateModel({ bareId: "lite", key: "lite" }), false);
  });

  it("only_ultimate cannot serve pro models", () => {
    const pro = addAccount({
      mode: "global",
      globalTier: "pro",
      credentials: creds("global", "pro1"),
      name: "pro1",
    });
    const ou = addAccount({
      mode: "global",
      globalTier: "only_ultimate",
      credentials: creds("global", "ou1"),
      name: "ou1",
    });
    const lite = resolveModelRoute("global/lite");
    const ult = resolveModelRoute("global/ultimate");
    assert.equal(canServeModel(pro, lite), true);
    assert.equal(canServeModel(ou, lite), false);
    assert.equal(canServeModel(ou, ult), true);
    assert.equal(canServeModel(pro, ult), true);
  });

  it("getNextAvailable skips only_ultimate for non-ultimate", () => {
    addAccount({
      mode: "global",
      globalTier: "only_ultimate",
      credentials: creds("global", "ou2"),
    });
    addAccount({
      mode: "global",
      globalTier: "pro",
      credentials: creds("global", "pro2"),
    });
    const lite = resolveModelRoute("global/lite");
    assert.equal(countAvailable(lite), 1);
    const picked = getNextAvailable(lite);
    assert.ok(picked);
    assert.equal(picked!.globalTier, "pro");
  });

  it("rate_limit freezes then recovers", () => {
    const a = addAccount({
      mode: "cn",
      credentials: creds("cn", "c1"),
    });
    reportError(a.id, "rate_limit");
    const route = resolveModelRoute("cn/auto");
    assert.equal(countAvailable(route), 0);
    updateAccount(a.id, { rateLimitUntil: Date.now() - 1000 });
    assert.equal(countAvailable(route), 1);
  });

  it("lists multiple accounts", () => {
    addAccount({ mode: "cn", credentials: creds("cn", "a") });
    addAccount({ mode: "cn", credentials: creds("cn", "b") });
    assert.equal(listAccounts().filter((x) => x.mode === "cn").length, 2);
  });
});
