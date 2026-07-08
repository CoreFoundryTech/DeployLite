import { describe, expect, it, vi } from "vitest";
import { createEnvSecretCipher, loadEnvSecretKey, redactSecrets } from "@deploylite/config";
import {
  MockHeartbeatClient,
  assertNoHostMutationPath,
  buildDeployEnvFile,
  createSafeCommandEnvelope,
  materializeMockDeploy,
  redactEnvFileForLog
} from "./index.js";

const SECRET_KEY = "deploylite-test-agent-secret-key-1234567890abcdef";
const cipher = createEnvSecretCipher(loadEnvSecretKey(SECRET_KEY));

const encrypted = (key: string, plaintext: string) => ({
  key,
  scope: "project" as const,
  encryptedValue: Buffer.from(cipher.encrypt(plaintext), "base64"),
  valueFingerprint: cipher.fingerprint(plaintext),
  keyVersion: 1
});

describe("mock agent boundary", () => {
  it("creates safe command envelopes with no Docker, shell, or host mutation flags", () => {
    const envelope = createSafeCommandEnvelope("agent_mock_1", "heartbeat", new Date("2026-01-01T00:00:00.000Z"));

    expect(envelope.safety).toEqual({
      mockOnly: true,
      dockerSocketAccess: false,
      hostShellExecution: false,
      mutatesHost: false
    });
    expect(assertNoHostMutationPath(envelope)).toBe(true);
  });

  it("sends heartbeat contracts through an injected transport only", async () => {
    const transport = { sendHeartbeat: vi.fn().mockResolvedValue({ accepted: true, requestId: "api_req_1" }) };
    const client = new MockHeartbeatClient({
      agentId: "agent_mock_1",
      transport,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const result = await client.sendHeartbeat();

    expect(result.accepted).toBe(true);
    expect(transport.sendHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_mock_1",
        observedAt: "2026-01-01T00:00:00.000Z",
        resourceSnapshot: expect.objectContaining({ cpuLoad: 0.24 })
      })
    );
  });
});

describe("materializeMockDeploy / buildDeployEnvFile", () => {
  it("round-trips an encrypted env value back to plaintext and writes it to the in-memory .env", () => {
    const database = "postgres://user:hunter2@db.local:5432/app";

    const entry = materializeMockDeploy({
      projectId: "project_alpha",
      agentId: "agent_mock_1",
      records: [encrypted("DATABASE_URL", database)],
      cipher
    });

    expect(entry.lines).toEqual([`DATABASE_URL=${database}`]);
    expect(entry.contents).toContain(`DATABASE_URL=${database}`);
    // The plaintext is held only for the duration of this call — it never
    // ends up on the result object as a separate field.
    expect((entry as unknown as { plaintext?: string }).plaintext).toBeUndefined();
  });

  it("supports multiple keys in a single materialized deploy and orders them deterministically", () => {
    const result = materializeMockDeploy({
      projectId: "project_alpha",
      agentId: "agent_mock_1",
      records: [
        encrypted("API_KEY", "sk_test_abcdefghij"),
        encrypted("DATABASE_URL", "postgres://u:p@h/d")
      ],
      cipher
    });

    // The deterministic order is by key (locale-aware) so a re-materialize
    // produces a stable byte-for-byte output. API_KEY < DATABASE_URL.
    expect(result.lines).toEqual([
      "API_KEY=sk_test_abcdefghij",
      "DATABASE_URL=postgres://u:p@h/d"
    ]);
  });

  it("buildDeployEnvFile returns the rendered string and never returns the per-key plaintext as a separate field", () => {
    const secret = "sk_test_abcdefghijklmnop";
    const built = buildDeployEnvFile([encrypted("API_KEY", secret)], cipher);

    expect(built.lines).toEqual([`API_KEY=${secret}`]);
    expect((built as unknown as { plaintext?: string }).plaintext).toBeUndefined();
    expect((built as unknown as { decrypted?: string }).decrypted).toBeUndefined();
  });

  it("refuses to materialize a deploy with a missing key, failing closed", () => {
    expect(() => materializeMockDeploy({
      projectId: "project_alpha",
      agentId: "agent_mock_1",
      records: [],
      env: {}
    })).toThrow(/DEPLOYLITE_SECRET_KEY/);
  });

  it("refuses to materialize a deploy when the cipher cannot decrypt a row", () => {
    const wrongCipher = createEnvSecretCipher(loadEnvSecretKey("another-deploylite-secret-key-zzz1234567890"));
    expect(() => materializeMockDeploy({
      projectId: "project_alpha",
      agentId: "agent_mock_1",
      records: [encrypted("DATABASE_URL", "postgres://u:p@h/d")],
      cipher: wrongCipher
    })).toThrow(/Env secret encryption failed|authentication tag/i);
  });
});

describe("redactEnvFileForLog", () => {
  it("strips every line's value, leaving only the key list, so logs never echo plaintext", () => {
    const rendered = `DATABASE_URL=postgres://u:p@h/d\nAPI_KEY=sk_test_abcdefghijklmnop`;
    const redacted = redactEnvFileForLog(rendered);

    expect(redacted).not.toContain("postgres://u:p@h/d");
    expect(redacted).not.toContain("sk_test_abcdefghijklmnop");
    // Keys stay visible so the operator can confirm what was wired up.
    expect(redacted).toContain("DATABASE_URL");
    expect(redacted).toContain("API_KEY");
  });

  it("strips the value of any KEY=VALUE line, even when the value is a fingerprint-shaped hex digest", () => {
    const rendered = `KEY=abcdef0123456789abcdef0123456789`;
    const redacted = redactEnvFileForLog(rendered);
    expect(redacted).toContain("KEY=[REDACTED]");
    expect(redacted).not.toContain("abcdef0123456789abcdef0123456789");
  });

  it("composes with the platform redaction for lines that do not look like KEY=VALUE", () => {
    // The first `=` splits the line. The key is kept; everything after
    // becomes [REDACTED]. Any token-shaped value after the first `=` is
    // scrubbed.
    const sample = "user=alice; token=sk_test_abcdef0123456789";
    const redacted = redactEnvFileForLog(sample);
    expect(redacted).toBe("user=[REDACTED]");
  });
});

describe("EnvMaterializedEntry shape", () => {
  it("never exposes decrypted values as a structured field — only the rendered .env string", () => {
    const records: Parameters<typeof buildDeployEnvFile>[0] = [
      encrypted("API_KEY", "sk_test_abcdefghijklmnop")
    ];
    const built = buildDeployEnvFile(records, cipher);
    const asRecord: Record<string, unknown> = built as unknown as Record<string, unknown>;
    expect(Object.keys(asRecord).sort()).toEqual(["agentId", "contents", "lines", "projectId"]);
  });

  it("materializeMockDeploy stamps project + agent ids on the result", () => {
    const entry = materializeMockDeploy({
      projectId: "project_alpha",
      agentId: "agent_mock_1",
      records: [encrypted("API_KEY", "sk_test_abcdefghij")],
      cipher
    });
    expect(entry.projectId).toBe("project_alpha");
    expect(entry.agentId).toBe("agent_mock_1");
  });
});
