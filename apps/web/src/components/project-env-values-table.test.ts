import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectEnvValuesTable,
  describeEnvValueDeleteFailure,
  maskFingerprint,
  runProjectEnvValueDelete,
  submitProjectEnvValue
} from "./project-env-values-table.js";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() })
}));

const envValueFixture: import("@deploylite/contracts").EnvSecretValue = {
  id: "env_value_abc",
  projectId: "project-1",
  key: "DATABASE_URL",
  scope: "project",
  valuePresent: true,
  valueFingerprint: "deadbeefdeadbeefdeadbeefdeadbeef",
  keyVersion: 1,
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-05T12:30:00.000Z"
};

const baseProps = {
  projectId: "project-1",
  apiBaseUrl: "https://api.example.test",
  cookieHeader: "deploylite_session=opaque"
};

describe("maskFingerprint", () => {
  it("shows the first 8 and last 4 characters of a fingerprint with a separator", () => {
    expect(maskFingerprint("deadbeefdeadbeefdeadbeefdeadbeef")).toBe("deadbeef…beef");
  });

  it("falls back to a generic mask when the fingerprint is too short to safely reveal", () => {
    expect(maskFingerprint("")).toBe("••••");
    expect(maskFingerprint(null)).toBe("••••");
    expect(maskFingerprint(undefined)).toBe("••••");
    expect(maskFingerprint("abc")).toBe("••••");
  });
});

describe("ProjectEnvValuesTable render markup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the masked secret input as type=password with autoComplete=new-password and the empty-state when no values exist", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectEnvValuesTable, {
      ...baseProps,
      envValues: []
    }));

    expect(html).toContain("id=\"env-value-value\"");
    // The raw-value input is a password field, never a text/textarea, so the
    // browser masks characters as the operator types and shoulder-surfing is
    // blocked at the DOM layer.
    expect(html).toContain('type="password"');
    expect(html).toContain("name=\"value\"");
    expect(html).toContain("id=\"env-value-key\"");
    expect(html).toContain("id=\"env-value-scope\"");
    expect(html).toContain("Save secret value");
    expect(html).toContain("No env secret values yet.");
    // OWASP: a write-only secret/password rotation field uses new-password so
    // browsers do not autofill a previously saved value (B7).
    expect(html).toContain('autoComplete="new-password"');
  });

  it("does not impose a charset pattern stricter than the server contract on the key input", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectEnvValuesTable, {
      ...baseProps,
      envValues: []
    }));

    // The contract is z.string().min(1).max(128) — keys with "-", ".", "/"
    // are legitimate. The old [A-Za-z0-9_]+ pattern must not be present (B6).
    expect(html).not.toContain('pattern="[A-Za-z0-9_]+"');
    // maxLength mirrors the contract's max(128).
    expect(html).toContain('maxLength="128"');
  });

  it("renders a row per value with the masked fingerprint, scope, and timestamps", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectEnvValuesTable, {
      ...baseProps,
      envValues: [envValueFixture]
    }));

    // Key + scope are visible as identifiers.
    expect(html).toContain("DATABASE_URL");
    expect(html).toContain(">project<");
    // Fingerprint is masked — full digest must NOT be in the rendered HTML.
    expect(html).toContain("deadbeef…beef");
    expect(html).not.toContain("deadbeefdeadbeefdeadbeefdeadbeef");
    // No raw-value path exists in the rendered output.
    expect(html).not.toContain('type="text" name="value"');
    expect(html).not.toMatch(/name="value"[^>]*value="/);
    // Copy-fingerprint action is present and explicitly labelled as the FULL
    // fingerprint (B9), not the masked preview — not copy-value.
    expect(html).toContain('aria-label="Copy full fingerprint for DATABASE_URL"');
    expect(html).toContain("Copy full fingerprint");
    expect(html).not.toContain("Copy value");
    expect(html).not.toContain("Reveal value");
    // Delete trigger exists and is scoped by scope+key (B8).
    expect(html).toContain("env-value-delete-project-DATABASE_URL");
    // Timestamps rendered (locale string format).
    expect(html).toMatch(/7\/1\/2026|01\/07\/2026|2026/);
  });

  it("never embeds the raw value in the rendered HTML for any value-related row or form field", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectEnvValuesTable, {
      ...baseProps,
      envValues: [
        envValueFixture,
        { ...envValueFixture, id: "env_value_def", key: "API_KEY", scope: "deployment", valueFingerprint: "12345678901234567890123456789012" }
      ]
    }));

    // Neither fingerprint (the API's only "secret-adjacent" field exposed to
    // the UI) should appear in full — both must be truncated.
    expect(html).not.toContain("deadbeefdeadbeefdeadbeefdeadbeef");
    expect(html).not.toContain("12345678901234567890123456789012");
    // Confirm both fingerprints are present, just masked.
    expect(html).toContain("deadbeef…beef");
    expect(html).toContain("12345678…9012");
    // No "value" attribute carries the plaintext in any rendered element.
    expect(html).not.toMatch(/\bdefaultValue=\"[^\"]+\"/);
  });

  it("keys per-row state and testids by scope+key so the same key under different scopes does not collide (B8)", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectEnvValuesTable, {
      ...baseProps,
      envValues: [
        { ...envValueFixture, scope: "project" },
        { ...envValueFixture, id: "env_value_def", scope: "deployment", valueFingerprint: "12345678901234567890123456789012" }
      ]
    }));

    // Both rows share the key DATABASE_URL but differ in scope; their testids
    // must be distinct so per-row state (copy feedback, delete dialog) cannot
    // collide.
    expect(html).toContain("env-value-row-project-DATABASE_URL");
    expect(html).toContain("env-value-row-deployment-DATABASE_URL");
    expect(html).toContain("env-value-copy-project-DATABASE_URL");
    expect(html).toContain("env-value-copy-deployment-DATABASE_URL");
    expect(html).toContain("env-value-delete-project-DATABASE_URL");
    expect(html).toContain("env-value-delete-deployment-DATABASE_URL");
  });

  it("renders the delete trigger behind a confirmation dialog structure (B3)", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectEnvValuesTable, {
      ...baseProps,
      envValues: [envValueFixture]
    }));

    // The destructive Remove button is the dialog trigger — the confirm gate
    // is wired through the Dialog primitive (dialog-trigger slot present).
    expect(html).toContain("data-slot=\"dialog-trigger\"");
    expect(html).toContain("env-value-delete-project-DATABASE_URL");
  });
});

describe("submitProjectEnvValue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns unconfigured when the API base URL is missing", async () => {
    const result = await submitProjectEnvValue({
      projectId: baseProps.projectId,
      apiBaseUrl: null,
      cookieHeader: baseProps.cookieHeader,
      payload: { key: "DATABASE_URL", scope: "project", value: "raw-secret" }
    });
    expect(result).toEqual({ kind: "unconfigured", message: "Configure DEPLOYLITE_WEB_API_BASE_URL before saving env values." });
  });

  it("POSTs the write-only envelope to /api/v1/projects/:id/env-values and returns saved on success", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        envValue: envValueFixture,
        audit: { action: "project.env-value.upsert", targetType: "env_value", targetId: envValueFixture.id }
      },
      error: null,
      requestId: "req_env_value_save_1"
    }), { status: 200 }));

    const result = await submitProjectEnvValue({
      projectId: baseProps.projectId,
      apiBaseUrl: baseProps.apiBaseUrl,
      cookieHeader: baseProps.cookieHeader,
      payload: { key: "DATABASE_URL", scope: "project", value: "raw-secret" },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result).toEqual({ kind: "saved", message: "Secret value saved. The encrypted record was updated." });
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe("https://api.example.test/api/v1/projects/project-1/env-values");
    expect(calledInit.method).toBe("POST");
    expect(calledInit.credentials).toBe("include");
    expect(JSON.parse(String(calledInit.body))).toEqual({
      key: "DATABASE_URL",
      scope: "project",
      value: "raw-secret"
    });
  });

  it("returns rejected when the API responds with a 4xx", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: null,
      error: { code: "VALIDATION_ERROR", message: "Invalid", correlationId: "req_env_value_400" },
      requestId: "req_env_value_400"
    }), { status: 400 }));

    const result = await submitProjectEnvValue({
      projectId: baseProps.projectId,
      apiBaseUrl: baseProps.apiBaseUrl,
      cookieHeader: baseProps.cookieHeader,
      payload: { key: "DATABASE_URL", scope: "project", value: "raw-secret" },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.kind).toBe("rejected");
    expect(result).toEqual({ kind: "rejected", message: "The API rejected the env value. Check the key/scope and try again." });
  });

  it("returns unreachable when the fetch call throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });

    const result = await submitProjectEnvValue({
      projectId: baseProps.projectId,
      apiBaseUrl: baseProps.apiBaseUrl,
      cookieHeader: baseProps.cookieHeader,
      payload: { key: "DATABASE_URL", scope: "project", value: "raw-secret" },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result).toEqual({ kind: "unreachable", message: "The local API is unreachable. Start the API and try again." });
  });
});

describe("runProjectEnvValueDelete", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("issues DELETE with key + scope query params and returns deleted on success", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: { removed: true, audit: { action: "project.env-value.delete", targetType: "env_value", targetId: "project-1:project:DATABASE_URL" } },
      error: null,
      requestId: "req_env_value_delete_1"
    }), { status: 200 }));

    const result = await runProjectEnvValueDelete({
      ...baseProps,
      key: "DATABASE_URL",
      scope: "project",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result).toEqual({ kind: "deleted", message: "Secret value removed." });
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe("https://api.example.test/api/v1/projects/project-1/env-values?key=DATABASE_URL&scope=project");
    expect(calledInit.method).toBe("DELETE");
  });

  it("returns a distinct not-found message when the API responds 404 (B5)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: null,
      error: { code: "NOT_FOUND", message: "Env value not found.", correlationId: "req_env_value_delete_404" },
      requestId: "req_env_value_delete_404"
    }), { status: 404 }));

    const result = await runProjectEnvValueDelete({
      ...baseProps,
      key: "DATABASE_URL",
      scope: "project",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("This env value is already gone. Reload the list.");
    }
  });

  it("returns a distinct forbidden message when the API responds 403 (B5)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: null,
      error: { code: "FORBIDDEN", message: "Forbidden.", correlationId: "req_env_value_delete_403" },
      requestId: "req_env_value_delete_403"
    }), { status: 403 }));

    const result = await runProjectEnvValueDelete({
      ...baseProps,
      key: "DATABASE_URL",
      scope: "project",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("You do not have permission to remove this env value.");
    }
  });

  it("returns a generic rejected message for a 5xx server error (B5)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: null,
      error: { code: "INTERNAL", message: "boom", correlationId: "req_env_value_delete_500" },
      requestId: "req_env_value_delete_500"
    }), { status: 500 }));

    const result = await runProjectEnvValueDelete({
      ...baseProps,
      key: "DATABASE_URL",
      scope: "project",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("The env value could not be removed. Refresh and try again.");
    }
  });

  it("returns unconfigured when the API base URL is missing", async () => {
    const result = await runProjectEnvValueDelete({
      ...baseProps,
      apiBaseUrl: null,
      key: "DATABASE_URL",
      scope: "project"
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("Configure DEPLOYLITE_WEB_API_BASE_URL before removing env values.");
    }
  });
});

describe("describeEnvValueDeleteFailure", () => {
  it("returns a distinct user-safe message for every failure class the API can produce (B5)", () => {
    expect(describeEnvValueDeleteFailure({ kind: "error", reason: "api-unconfigured" }))
      .toBe("Configure DEPLOYLITE_WEB_API_BASE_URL before removing env values.");
    expect(describeEnvValueDeleteFailure({ kind: "error", reason: "not-found", status: 404 }))
      .toBe("This env value is already gone. Reload the list.");
    // 403 under api-rejected is the forbidden branch.
    expect(describeEnvValueDeleteFailure({ kind: "error", reason: "api-rejected", status: 403 }))
      .toBe("You do not have permission to remove this env value.");
    // Any other status under api-rejected is the generic rejected branch.
    expect(describeEnvValueDeleteFailure({ kind: "error", reason: "api-rejected", status: 500 }))
      .toBe("The env value could not be removed. Refresh and try again.");
    expect(describeEnvValueDeleteFailure({ kind: "error", reason: "invalid-payload" }))
      .toBe("Remove response was invalid. Refresh and try again.");
    expect(describeEnvValueDeleteFailure({ kind: "error", reason: "api-unreachable" }))
      .toBe("The local API is unreachable. Start the API and try again.");
  });
});
