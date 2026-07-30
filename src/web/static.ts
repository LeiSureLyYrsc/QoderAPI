import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

export function publicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../public"),
    path.resolve(here, "../../../public"),
    path.resolve(process.cwd(), "public"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return candidates[0]!;
}

function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function tryServeStatic(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string
): boolean {
  const root = publicDir();
  let rel = urlPath.split("?")[0] || urlPath;
  if (rel === "/ui" || rel === "/ui/") rel = "/ui/index.html";
  if (!rel.startsWith("/ui/")) return false;

  const sub = decodeURIComponent(rel.slice("/ui/".length) || "index.html");
  if (!sub || sub.includes("\0")) {
    res.writeHead(400).end("bad path");
    return true;
  }

  const filePath = path.resolve(root, sub);
  if (!isInsideRoot(root, filePath)) {
    res.writeHead(400).end("bad path");
    return true;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const index = path.join(root, "index.html");
    if (fs.existsSync(index)) {
      const data = fs.readFileSync(index);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
      res.end(data);
      return true;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end(
      `UI not found. Looked in: ${root}`
    );
    return true;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const data = fs.readFileSync(filePath);
  // Never long-cache UI assets — HTML/JS/CSS change often during iteration.
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
  });
  res.end(data);
  return true;
}
