const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i;
const SECRET_VALUE_PATTERN = /\b((?:sk|pk|ghp|glpat|dop|dl)_[A-Za-z0-9_\-]{8,}|[A-Za-z0-9+/]{32,}={0,2})\b/g;
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const SAFE_VALUE_KEY_PATTERN = /(fingerprint|checksum|hash|etag|digest|signature|hex|digest|sha\d*|md\d*)$/i;
const SAFE_HEX_VALUE_PATTERN = /^[0-9a-f]+$/i;
const SAFE_UUID_VALUE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REDACTED = "[REDACTED]";

function isKnownSafeValue(key: string, value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (SAFE_UUID_VALUE_PATTERN.test(value)) return true;
  if (SAFE_VALUE_KEY_PATTERN.test(key) && SAFE_HEX_VALUE_PATTERN.test(value)) return true;
  return false;
}

export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`).replace(SECRET_VALUE_PATTERN, REDACTED) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => {
        if (SECRET_KEY_PATTERN.test(key)) return [key, REDACTED];
        if (typeof nested === "string" && isKnownSafeValue(key, nested)) return [key, nested];
        return [key, redactSecrets(nested)];
      })
    ) as T;
  }

  return value;
}

export function redactLogMessage(message: string): string {
  return redactSecrets(message);
}
