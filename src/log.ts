export function isDebug(): boolean {
  const v = String(process.env.QODER_DEBUG || process.env.DEBUG || "").trim();
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "qoder";
}

function stamp(): string {
  return new Date().toISOString();
}

function write(level: string, args: unknown[]): void {
  const line = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return formatErr(a);
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  console.error(`[${stamp()}] [${level}] ${line}`);
}

export function logInfo(...args: unknown[]): void {
  write("info", args);
}

export function logWarn(...args: unknown[]): void {
  write("warn", args);
}

export function logError(...args: unknown[]): void {
  write("error", args);
}

export function logDebug(...args: unknown[]): void {
  if (!isDebug()) return;
  write("debug", args);
}

export function formatErr(err: unknown): string {
  if (err instanceof Error) {
    const cause =
      err.cause != null
        ? `\n  cause: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`
        : "";
    if (isDebug() && err.stack) return `${err.stack}${cause}`;
    return `${err.message}${cause}`;
  }
  return String(err);
}

export function maskSecret(value: string | undefined | null, keep = 6): string {
  const s = String(value || "").trim();
  if (!s) return "(empty)";
  if (s.length <= keep) return `${s[0] || ""}***`;
  return `${s.slice(0, keep)}…`;
}
