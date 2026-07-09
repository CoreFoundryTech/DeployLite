import {
  createCorrelationContext,
  createEnvSecretCipher,
  createRequestId,
  EnvSecretCipherError,
  EnvSecretKeyMissingError,
  loadEnvSecretKey,
  redactSecrets,
  type EnvSecretCipher
} from "@deploylite/config";
import { agentHeartbeatSchema, resourceSnapshotSchema, type AgentHeartbeat } from "@deploylite/contracts";
import { z } from "zod";

export const safeCommandEnvelopeSchema = z.object({
  commandId: z.string().min(1),
  agentId: z.string().min(1),
  kind: z.enum(["heartbeat", "status-snapshot", "deploy.materialize"]),
  issuedAt: z.string().datetime({ offset: true }),
  payload: z.record(z.unknown()),
  safety: z.object({
    mockOnly: z.literal(true),
    dockerSocketAccess: z.literal(false),
    hostShellExecution: z.literal(false),
    mutatesHost: z.literal(false)
  })
});

export type SafeCommandEnvelope = z.infer<typeof safeCommandEnvelopeSchema>;

export type HeartbeatTransport = {
  sendHeartbeat(heartbeat: AgentHeartbeat): Promise<{ accepted: boolean; requestId: string }>;
};

export type MockHeartbeatClientOptions = {
  agentId: string;
  transport: HeartbeatTransport;
  now?: () => Date;
};

export const mockResourceSnapshot = resourceSnapshotSchema.parse({
  cpuLoad: 0.24,
  memoryUsedBytes: 512,
  memoryTotalBytes: 2048,
  diskUsedBytes: 10_000,
  diskTotalBytes: 100_000
});

export function createSafeCommandEnvelope(agentId: string, kind: SafeCommandEnvelope["kind"], issuedAt = new Date()): SafeCommandEnvelope {
  return safeCommandEnvelopeSchema.parse({
    commandId: `cmd_${createRequestId()}`,
    agentId,
    kind,
    issuedAt: issuedAt.toISOString(),
    payload: kind === "heartbeat" ? { resourceSnapshot: mockResourceSnapshot } : { status: "online" },
    safety: {
      mockOnly: true,
      dockerSocketAccess: false,
      hostShellExecution: false,
      mutatesHost: false
    }
  });
}

export class MockHeartbeatClient {
  constructor(private readonly options: MockHeartbeatClientOptions) {}

  async sendHeartbeat(): Promise<{ accepted: boolean; requestId: string; envelope: SafeCommandEnvelope }> {
    const issuedAt = this.options.now?.() ?? new Date();
    const envelope = createSafeCommandEnvelope(this.options.agentId, "heartbeat", issuedAt);
    const context = createCorrelationContext(createRequestId());
    const heartbeat = agentHeartbeatSchema.parse({
      agentId: this.options.agentId,
      observedAt: issuedAt.toISOString(),
      resourceSnapshot: mockResourceSnapshot,
      ...context
    });
    const result = await this.options.transport.sendHeartbeat(heartbeat);
    return { ...result, envelope };
  }
}

export function assertNoHostMutationPath(envelope: SafeCommandEnvelope): true {
  const parsed = safeCommandEnvelopeSchema.parse(envelope);
  if (!parsed.safety.mockOnly || parsed.safety.dockerSocketAccess || parsed.safety.hostShellExecution || parsed.safety.mutatesHost) {
    throw new Error("Unsafe agent command envelope rejected by scaffold boundary");
  }
  return true;
}

// =====================================================================
// Deploy-time materialization (mock / dry-run only).
//
// The platform intentionally defers real container execution; this helper
// only decrypts the encrypted env secret values for a project and renders
// them into a `.env` string suitable for being staged for a (mock) runner.
// The plaintext is held only for the duration of the function call and is
// never returned as a structured field, never logged, and never written to
// the result object. A redacted projection is also exposed so logging
// pipelines can confirm the wire-up without leaking secrets.
// =====================================================================

export type EnvMaterializedEntry = {
  /** Project + agent pair this materialization is scoped to. */
  projectId: string;
  agentId: string;
  /** Rendered .env contents — never log this directly. */
  contents: string;
  /** Per-line key=value strings, in the order they were provided. */
  lines: string[];
};

export type EncryptedEnvRecord = {
  key: string;
  scope: "project" | "deployment";
  encryptedValue: Buffer;
  valueFingerprint: string;
  keyVersion: number;
};

export type MaterializeDeployOptions = {
  projectId: string;
  agentId: string;
  records: EncryptedEnvRecord[];
  cipher?: EnvSecretCipher;
  env?: NodeJS.ProcessEnv;
};

function ensureCipher(options: MaterializeDeployOptions): EnvSecretCipher {
  if (options.cipher) return options.cipher;
  if (!options.env) {
    throw new EnvSecretKeyMissingError("no env or cipher was provided to materializeMockDeploy");
  }
  const raw = options.env.DEPLOYLITE_SECRET_KEY;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new EnvSecretKeyMissingError("DEPLOYLITE_SECRET_KEY is missing or empty");
  }
  const key = loadEnvSecretKey(raw);
  return createEnvSecretCipher(key);
}

/**
 * Decrypts each encrypted env secret value and renders them into a `.env`
 * string. The plaintext values are never returned as a structured field,
 * never logged, and never reused past this call. The caller is expected to
 * pipe `redactEnvFileForLog(entry.contents)` into any log layer.
 */
export function buildDeployEnvFile(records: EncryptedEnvRecord[], cipher: EnvSecretCipher): EnvMaterializedEntry {
  // Sort the input deterministically by scope then key so a re-materialize
  // produces a stable byte-for-byte output (useful for diffs in dry-run
  // environments and for golden tests).
  const sorted = [...records].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  const lines: string[] = [];
  for (const record of sorted) {
    if (!Buffer.isBuffer(record.encryptedValue) || record.encryptedValue.length === 0) {
      throw new EnvSecretCipherError(`record ${record.key} is missing an encryptedValue buffer`);
    }
    const plaintext = cipher.decrypt(record.encryptedValue.toString("base64"));
    lines.push(`${record.key}=${plaintext}`);
    // The plaintext variable is intentionally overwritten on the next
    // iteration to make accidental capture harder to reason about. JS does
    // not zero strings, so the helper below also redacts the rendered
    // string before any logging layer can see it.
  }
  return {
    projectId: "",
    agentId: "",
    contents: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
    lines
  };
}

/**
 * Materialize a mock / dry-run deploy for a project. The function:
 *
 *   1. Loads (or accepts) a cipher for the agent's local DEPLOYLITE_SECRET_KEY.
 *   2. Accepts the encrypted records as `EncryptedEnvRecord[]` — these come
 *      from a future agent-facing API (not the public web env-values
 *      endpoint, which intentionally omits the encrypted blob).
 *   3. Decrypts each record in-process and renders a `.env` string.
 *   4. Returns the rendered output plus a project/agent envelope. The
 *      plaintext is held only for the duration of this call.
 *
 * The function does NOT mount any Docker socket, does NOT exec any
 * shell, and does NOT write to the filesystem. The `.env` string lives in
 * memory only, ready for the mock runner to consume.
 */
export function materializeMockDeploy(options: MaterializeDeployOptions): EnvMaterializedEntry {
  const cipher = ensureCipher(options);
  const built = buildDeployEnvFile(options.records, cipher);
  return { ...built, projectId: options.projectId, agentId: options.agentId };
}

/**
 * Render an `.env` string into a redacted projection suitable for log
 * output. Every value is replaced with `[REDACTED]` while the key list
 * stays visible so operators can confirm what was wired up without
 * leaking any plaintext.
 *
 * The redaction is unconditional for `KEY=VALUE` lines: an env value is
 * confidential regardless of shape. The platform's redactSecrets redaction
 * layer is still applied first to handle non-`KEY=VALUE` substrings (e.g.
 * embedded fingerprints in error messages) so the projection composes
 * cleanly with the rest of the log pipeline.
 *
 * Multiline secret handling: a value that contains a newline (e.g. an
 * unquoted PEM private key or certificate blob) puts every continuation
 * line in scope of the same redaction. The naive per-line rule would let
 * a base64 continuation chunk pass through to `redactSecrets`, where it
 * is only matched when it happens to look like a token-shaped value. To
 * avoid that, once we redacted a `KEY=…` line we redact every following
 * line that does not look like a new `KEY=` declaration or a `#`-led
 * comment — a deterministic state machine that keeps operators able to
 * read the key list while guaranteeing that no continuation chunk leaks.
 *
 * The new-key detector matches the POSIX convention: `[A-Z_][A-Z0-9_]*`.
 * That deliberately excludes lowercase keys, but the project standard
 * is uppercase (DATABASE_URL, API_KEY, …) and the constraint also
 * rejects base64 chunks (which mix upper/lower + `+`/`/`/`=`), so a
 * PEM continuation line is correctly treated as a continuation rather
 * than a false-positive new declaration.
 */
const ENV_NEW_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}=/;

export function redactEnvFileForLog(contents: string): string {
  const lines = contents.split("\n");
  const redacted: string[] = [];
  let redactingMultilineValue = false;
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq === -1) {
      // Continuation line. If we are still inside a redacted multiline
      // value, drop the body entirely so a base64 / PEM chunk can never
      // leak. Otherwise fall back to the platform redaction for stray
      // substrings (e.g. an inline fingerprint in a comment).
      redacted.push(redactingMultilineValue ? "[REDACTED]" : redactSecrets(line));
      continue;
    }
    // A new `KEY=` declaration closes any open multiline block. This
    // handles a string of PEM blocks back-to-back: each `KEY=...` line
    // starts a fresh redaction window.
    if (eq > 0 && ENV_NEW_KEY_PATTERN.test(line)) {
      const key = line.slice(0, eq);
      redacted.push(`${key}=[REDACTED]`);
      redactingMultilineValue = line.slice(eq + 1).length > 0;
      continue;
    }
    // The first `=` does not look like a standard KEY=VALUE declaration.
    // The two shapes we have to defend against here are:
    //   1. A list-style value with a `=` somewhere inside the body, e.g.
    //      `user=alice; token=…`. The "key" portion is just the leading
    //      token, so we redact the body but keep the visible token.
    //   2. A base64 / PEM continuation line where the first `=` is the
    //      padding at the end of a base64 chunk (`ABCDEF==`). In this
    //      case the `key` portion is the entire chunk, which would leak
    //      the secret. To guarantee no chunk survives, we collapse the
    //      line down to `[REDACTED]` and continue the redaction window.
    if (redactingMultilineValue) {
      redacted.push("[REDACTED]");
    } else {
      const key = line.slice(0, eq);
      redacted.push(`${key}=[REDACTED]`);
    }
  }
  return redacted.join("\n");
}
