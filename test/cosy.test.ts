import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAuthHeaders } from "../src/crypto/cosy.ts";

describe("buildAuthHeaders", () => {
  it("produces COSY bearer and required headers", () => {
    const body = Buffer.from('{"x":1}');
    const headers = buildAuthHeaders(
      body,
      "https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1",
      {
        userID: "user-1",
        authToken: "token-abc",
        name: "Test",
        email: "t@example.com",
        machineID: "11111111-1111-1111-1111-111111111111",
      }
    );

    assert.match(headers.Authorization!, /^Bearer COSY\.[A-Za-z0-9+/=]+\.[a-f0-9]{32}$/);
    assert.ok(headers["Cosy-Key"]);
    assert.equal(headers["Cosy-User"], "user-1");
    assert.equal(headers["Cosy-Machineid"], "11111111-1111-1111-1111-111111111111");
    assert.equal(headers["Cosy-Sigpath"], "/api/v2/model/list");
    assert.equal(headers["Cosy-Bodylength"], String(body.length));
    assert.equal(headers["Cosy-Bodyhash"]!.length, 32);
    assert.equal(headers["Login-Version"], "v2");
  });

  it("rejects empty credentials", () => {
    assert.throws(() =>
      buildAuthHeaders(undefined, "https://example.com/algo/x", {
        userID: "",
        authToken: "t",
      })
    );
    assert.throws(() =>
      buildAuthHeaders(undefined, "https://example.com/algo/x", {
        userID: "u",
        authToken: "",
      })
    );
  });
});
