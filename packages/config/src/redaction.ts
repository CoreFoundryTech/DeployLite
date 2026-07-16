const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i;
const SECRET_VALUE_PATTERN = /\b((?:sk|pk|ghp|glpat|dop|dl)_[A-Za-z0-9_\-]{8,}|[A-Za-z0-9+/]{32,}={0,2})\b/g;
const SAFE_VALUE_KEY_PATTERN = /(fingerprint|checksum|hash|etag|digest|signature|hex|digest|sha\d*|md\d*)$/i;
const SAFE_HEX_VALUE_PATTERN = /^[0-9a-f]+$/i;
const SAFE_UUID_VALUE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REDACTED = "[REDACTED]";
const SAFE_PROJECTION_KEYS = new Set([
  "requestId", "correlationId", "id", "actorId", "action", "targetType", "targetId", "timestamp", "service", "mode", "safety", "metadata",
  "agents", "summary", "agentCount", "onlineAgentCount", "name", "endpoint", "status", "lastHeartbeatAt", "resourceSnapshot",
  "cpuLoad", "memoryUsedBytes", "memoryTotalBytes", "diskUsedBytes", "diskTotalBytes", "deployments", "projectId", "agentId",
  "commitSha", "startedAt", "finishedAt", "deploymentId", "events", "sequence", "level", "message", "redactionApplied", "resume",
  "afterSequence", "nextAfterSequence", "readOnly", "destructive", "dockerSocketAccess", "hostShellExecution", "traefikAcmeMutation",
  "productionAuthClaims", "redacted", "reason", "role", "allowedRoles", "projectId", "key", "scope", "keyVersion", "classification", "status", "field", "password", "valueFingerprint"
]);

export type SafeProjectionSurface = "api" | "log" | "sse" | "mcp" | "ai";

function isKnownSafeValue(key: string, value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (SAFE_UUID_VALUE_PATTERN.test(value)) return true;
  if (SAFE_VALUE_KEY_PATTERN.test(key) && SAFE_HEX_VALUE_PATTERN.test(value)) return true;
  return false;
}

export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE_PATTERN, REDACTED) as T;
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

/**
 * Produces the only object shape allowed to leave the control plane. The
 * surface is explicit for call-site auditing; fields not on this allowlist are
 * omitted, including unknown nested data such as env values and certificates.
 */
export function createSafeProjection(_surface: SafeProjectionSurface, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => SAFE_PROJECTION_KEYS.has(key))
    .map(([key, nested]) => [key, SECRET_KEY_PATTERN.test(key) ? REDACTED : typeof nested === "string" && isKnownSafeValue(key, nested) ? nested : Array.isArray(nested)
      ? nested.map((item) => createSafeProjection(_surface, item))
      : nested && typeof nested === "object" ? createSafeProjection(_surface, nested) : redactSecrets(nested)]));
}
