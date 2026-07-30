/** WAF body obfuscation used when URL has Encode=1. */

const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function qoderEncodeBody(plaintext: string | Buffer): string {
  const std = Buffer.isBuffer(plaintext)
    ? plaintext.toString("base64")
    : Buffer.from(plaintext).toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = rearranged[i]!;
    if (c === "=") {
      out += "$";
    } else {
      const idx = STD_ALPHABET.indexOf(c);
      out += idx >= 0 ? CUSTOM_ALPHABET[idx]! : c;
    }
  }
  return out;
}

/** Best-effort reverse of qoderEncodeBody (for debugging / tests). */
export function qoderDecodeBody(encoded: string): Buffer {
  let mapped = "";
  for (let i = 0; i < encoded.length; i++) {
    const c = encoded[i]!;
    if (c === "$") {
      mapped += "=";
    } else {
      const idx = CUSTOM_ALPHABET.indexOf(c);
      mapped += idx >= 0 ? STD_ALPHABET[idx]! : c;
    }
  }
  const n = mapped.length;
  const a = Math.floor(n / 3);
  // reverse: rearranged = tail(a) + mid + head(a)
  // original = head(a) + mid + tail(a)
  const tail = mapped.slice(0, a);
  const head = mapped.slice(n - a);
  const mid = mapped.slice(a, n - a);
  const std = head + mid + tail;
  return Buffer.from(std, "base64");
}
