import crypto from "node:crypto";
import {
  COSY_CLIENT_TYPE,
  COSY_DATA_POLICY,
  COSY_LOGIN_VERSION,
  COSY_MACHINE_TYPE,
  COSY_VERSION,
  machineOs,
} from "../config/endpoints.js";
import { getMachineId } from "./machine-id.js";

/** Hardcoded public key used by official Qoder clients for Cosy-Key wrapping. */
export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export interface CosyCreds {
  userID: string;
  authToken: string;
  name?: string;
  email?: string;
  machineID?: string;
}

export function rsaEncryptBase64(data: string | Buffer): string {
  const encrypted = crypto.publicEncrypt(
    {
      key: QODER_RSA_PUBLIC_KEY,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    typeof data === "string" ? Buffer.from(data) : data
  );
  return encrypted.toString("base64");
}

export function aesEncryptCBCBase64(plaintext: string, keyStr: string): string {
  const key = Buffer.from(keyStr);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
  return cipher.update(plaintext, "utf8", "base64") + cipher.final("base64");
}

/** Path used in MD5 signature: pathname with leading /algo stripped. */
export function computeSigPath(urlStr: string): string {
  const parsed = new URL(urlStr);
  let sigPath = parsed.pathname;
  if (sigPath.startsWith("/algo")) {
    sigPath = sigPath.slice("/algo".length);
  }
  return sigPath || "/";
}

export function buildAuthHeaders(
  body: string | Buffer | undefined,
  requestURL: string,
  creds: CosyCreds
): Record<string, string> {
  if (!creds.userID) throw new Error("cosy: user id is empty");
  if (!creds.authToken) throw new Error("cosy: auth token is empty");

  const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name || "",
    aid: "",
    email: creds.email || "",
  };
  const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey);
  const cosyKey = rsaEncryptBase64(aesKey);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestId = crypto.randomUUID();
  const cosyPayload = {
    version: "v1",
    requestId,
    info: infoB64,
    cosyVersion: COSY_VERSION,
    ideVersion: "",
  };
  const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString("base64");
  const sigPath = computeSigPath(requestURL);
  const bodyStr = body
    ? Buffer.isBuffer(body)
      ? body.toString("utf8")
      : body
    : "";
  const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`;
  const sig = crypto.createHash("md5").update(sigInput).digest("hex");
  const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0);
  const bodyHash = crypto.createHash("md5").update(bodyBuf).digest("hex");
  const machineID = creds.machineID || getMachineId();

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": timestamp,
    "Cosy-Version": COSY_VERSION,
    "Cosy-Machineid": machineID,
    "Cosy-Machinetoken": machineID,
    "Cosy-Machinetype": COSY_MACHINE_TYPE,
    "Cosy-Machineos": machineOs(),
    "Cosy-Clienttype": COSY_CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": bodyHash,
    "Cosy-Bodylength": bodyBuf.length.toString(),
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": COSY_DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": COSY_LOGIN_VERSION,
    "X-Request-Id": crypto.randomUUID(),
  };
}
