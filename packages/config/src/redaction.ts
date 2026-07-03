const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i;
const SECRET_VALUE_PATTERN = /\b((?:sk|pk|ghp|glpat|dop|dl)_[A-Za-z0-9_\-]{8,}|[A-Za-z0-9+/]{32,}={0,2})\b/g;
const REDACTED = "[REDACTED]";

export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE_PATTERN, REDACTED) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(nested)
      ])
    ) as T;
  }

  return value;
}

export function redactLogMessage(message: string): string {
  return redactSecrets(message);
}
