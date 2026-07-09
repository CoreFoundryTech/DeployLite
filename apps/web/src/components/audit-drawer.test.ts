import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEventListItem } from "@deploylite/contracts";
import {
  AuditDrawerContent,
  describeAuditListFailure,
  fireRefresh,
  maskAuditActor,
  maskAuditTarget,
  renderAuditTimestamp,
  resolveAuditFilterApply,
  scrubFingerprintLikeValues
} from "./audit-drawer.js";

const event = (overrides: Partial<AuditEventListItem>): AuditEventListItem => ({
  id: overrides.id ?? "audit_1",
  actorId: overrides.actorId ?? "user_admin_1",
  action: overrides.action ?? "project.create",
  targetType: overrides.targetType ?? "project",
  targetId: overrides.targetId ?? "project_alpha",
  requestId: overrides.requestId ?? "req_1",
  correlationId: overrides.correlationId ?? "corr_1",
  timestamp: overrides.timestamp ?? "2026-07-01T12:00:00.000Z"
});

describe("maskAuditActor", () => {
  it("returns the raw actorId when it fits the audit shape", () => {
    expect(maskAuditActor("user_admin_1")).toBe("user_admin_1");
  });

  it("annotates the system / anonymous placeholders so the UI never confuses them with real users", () => {
    expect(maskAuditActor("system")).toBe("system · automated");
    expect(maskAuditActor("anonymous")).toBe("anonymous · pre-login");
  });

  it("falls back to a masked preview when the actor is an opaque UUID-shaped id", () => {
    expect(maskAuditActor("8b3f6e6a-1e0a-4a2b-9c5d-feedfacefeed")).toBe("8b3f6e6a…eed");
  });
});

describe("maskAuditTarget", () => {
  it("renders the target id fully — it is a public project/env reference, not a secret", () => {
    expect(maskAuditTarget("project_alpha")).toBe("project_alpha");
    expect(maskAuditTarget("project_alpha:project:DB_URL")).toBe("project_alpha:project:DB_URL");
  });

  it("scrubs a 32+ char hex digest that somehow lands in the target column", () => {
    const fingerprint = "abcdef0123456789abcdef0123456789";
    expect(maskAuditTarget(`project_alpha:${fingerprint}`)).toBe(`project_alpha:[REDACTED]`);
  });
});

describe("scrubFingerprintLikeValues", () => {
  it("collapses any 32+ char hex substring to [REDACTED]", () => {
    const fingerprint = "abcdef0123456789abcdef0123456789";
    expect(scrubFingerprintLikeValues(fingerprint)).toBe("[REDACTED]");
  });

  it("leaves non-digest strings untouched so operator-visible ids stay readable", () => {
    expect(scrubFingerprintLikeValues("project_alpha")).toBe("project_alpha");
    expect(scrubFingerprintLikeValues("req_1")).toBe("req_1");
  });

  it("returns the original value untouched for empty / non-string inputs", () => {
    expect(scrubFingerprintLikeValues("")).toBe("");
  });

  it("scrubs the digest inside a mixed-shape string without disturbing surrounding text", () => {
    expect(scrubFingerprintLikeValues("evt-abcdef0123456789abcdef0123456789-extra")).toBe("evt-[REDACTED]-extra");
  });
});

describe("renderAuditTimestamp", () => {
  it("renders an ISO timestamp as a localized string", () => {
    const rendered = renderAuditTimestamp("2026-07-01T12:00:00.000Z");
    expect(typeof rendered).toBe("string");
    expect(rendered).not.toBe("2026-07-01T12:00:00.000Z");
  });

  it("returns the em-dash sentinel for missing or empty timestamps", () => {
    expect(renderAuditTimestamp(null)).toBe("—");
    expect(renderAuditTimestamp(undefined)).toBe("—");
    expect(renderAuditTimestamp("")).toBe("—");
  });

  it("returns the original string for non-ISO inputs so the UI shows the raw value rather than NaN", () => {
    expect(renderAuditTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("describeAuditListFailure", () => {
  it("maps each failure class to a distinct, actionable UI string", () => {
    expect(describeAuditListFailure({ kind: "error", reason: "forbidden" })).toMatch(/operator or admin/i);
    expect(describeAuditListFailure({ kind: "error", reason: "api-unconfigured" })).toMatch(/configure/i);
    expect(describeAuditListFailure({ kind: "error", reason: "api-unreachable" })).toMatch(/unreachable/i);
    expect(describeAuditListFailure({ kind: "error", reason: "invalid-payload" })).toMatch(/invalid/i);
    expect(describeAuditListFailure({ kind: "error", reason: "api-rejected" })).toMatch(/try again/i);
  });
});

describe("resolveAuditFilterApply", () => {
  it("forwards the actor input value to the actor filter key", () => {
    expect(resolveAuditFilterApply("audit-drawer-actor", "user_admin_1")).toEqual({ actor: "user_admin_1" });
  });

  it("forwards the action input value to the action filter key", () => {
    expect(resolveAuditFilterApply("audit-drawer-action", "project.env-value")).toEqual({ action: "project.env-value" });
  });

  it("normalizes an empty / whitespace-only value to undefined so the server never sees an empty match", () => {
    expect(resolveAuditFilterApply("audit-drawer-actor", "")).toEqual({ actor: undefined });
    expect(resolveAuditFilterApply("audit-drawer-actor", "   ")).toEqual({ actor: undefined });
    expect(resolveAuditFilterApply("audit-drawer-action", "")).toEqual({ action: undefined });
  });

  it("trims surrounding whitespace from real input values", () => {
    expect(resolveAuditFilterApply("audit-drawer-actor", "  user_admin_1  ")).toEqual({ actor: "user_admin_1" });
  });

  it("never crosses an actor value into the action filter (regression — the wiring used to be hard-coded in a click handler)", () => {
    expect(resolveAuditFilterApply("audit-drawer-actor", "project.env-value")).toEqual({ actor: "project.env-value" });
    expect(resolveAuditFilterApply("audit-drawer-action", "user_admin_1")).toEqual({ action: "user_admin_1" });
  });
});

describe("fireRefresh", () => {
  it("forwards the resolved filter to a synchronous handler exactly once", () => {
    // This is the round 1 regression: the static-render test used to
    // only assert the testid of the apply button without ever
    // exercising the click. By driving the same helper the click
    // handler uses, the wiring is now provable: clicking the actor
    // input's Apply button MUST call onRefresh with `{ actor }`.
    const handler = vi.fn();
    fireRefresh(handler, resolveAuditFilterApply("audit-drawer-actor", "user_admin_1"));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ actor: "user_admin_1" });
  });

  it("forwards the action filter to a synchronous handler", () => {
    const handler = vi.fn();
    fireRefresh(handler, resolveAuditFilterApply("audit-drawer-action", "project.env-value"));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ action: "project.env-value" });
  });

  it("forwards an empty filter to the refresh handler when the global Refresh button is clicked", () => {
    const handler = vi.fn();
    fireRefresh(handler, {});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({});
  });

  it("swallows a rejection from an async handler so an unhandled promise never escapes the click handler", async () => {
    const rejection = new Error("upstream API is down");
    const handler = vi.fn(async () => {
      throw rejection;
    });
    // Drive the click: must not throw, must not produce a floating
    // unhandled promise rejection in the test runner.
    expect(() => fireRefresh(handler, resolveAuditFilterApply("audit-drawer-actor", "user_admin_1"))).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
    // Yield to the microtask queue so the swallowed rejection settles.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("swallows a synchronous throw from a handler so the click contract holds", () => {
    const handler = vi.fn(() => {
      throw new Error("synchronous explosion");
    });
    expect(() => fireRefresh(handler, resolveAuditFilterApply("audit-drawer-actor", "user_admin_1"))).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("AuditDrawerContent render markup", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the empty-state copy when the loaded list has no events", () => {
    const html = renderToStaticMarkup(
      React.createElement(AuditDrawerContent, {
        events: [],
        total: 0,
        limit: 50,
        offset: 0,
        state: { kind: "ready" }
      })
    );
    expect(html).toContain("No audit events yet");
    expect(html).toContain("data-testid=\"audit-drawer\"");
  });

  it("renders an actionable forbidden empty-state when the role is read-only", () => {
    const html = renderToStaticMarkup(
      React.createElement(AuditDrawerContent, {
        events: [],
        total: 0,
        limit: 50,
        offset: 0,
        state: { kind: "error", reason: "forbidden", status: 403 }
      })
    );
    expect(html).toMatch(/operator or admin/i);
  });

  it("renders a list of events with masked actors, action, and target columns", () => {
    const html = renderToStaticMarkup(
      React.createElement(AuditDrawerContent, {
        events: [
          event({ id: "ev_alpha", action: "project.create", targetId: "project_alpha", timestamp: "2026-07-01T10:00:00.000Z" }),
          event({ id: "ev_beta", actorId: "system", action: "project.env-value.upsert", targetId: "project_alpha:project:DB_URL", timestamp: "2026-07-01T10:01:00.000Z" })
        ],
        total: 2,
        limit: 50,
        offset: 0,
        state: { kind: "ready" }
      })
    );
    expect(html).toContain("ev_alpha");
    expect(html).toContain("ev_beta");
    expect(html).toContain("project.create");
    expect(html).toContain("project.env-value.upsert");
    expect(html).toContain("project_alpha:project:DB_URL");
    // system / anonymous placeholders are annotated, never rendered as raw ids.
    expect(html).toContain("system · automated");
  });

  it("scrubs a leaked 32+ char hex digest in any visible column — the API strips metadata, but a regression that surfaces a valueFingerprint must not echo to the DOM", () => {
    // The API surface is metadata-stripped, so the only realistic way a
    // fingerprint lands in the DOM is if it shows up in one of the visible
    // columns (targetId, actorId, requestId). This test exercises the
    // defensive scrubber end-to-end: seed an event whose targetId carries
    // a SHA-256-shaped hex digest and assert the rendered HTML never
    // contains the digest.
    const fingerprint = "abcdef0123456789abcdef0123456789";
    const html = renderToStaticMarkup(
      React.createElement(AuditDrawerContent, {
        events: [
          event({
            id: "ev_leaked_fp",
            action: "project.env-value.upsert",
            targetId: `envv_env_1:${fingerprint}`,
            requestId: `req_${fingerprint}`
          })
        ],
        total: 1,
        limit: 50,
        offset: 0,
        state: { kind: "ready" }
      })
    );
    expect(html).not.toContain(fingerprint);
    expect(html).toContain("[REDACTED]");
  });

  it("renders the filter apply controls when an onRefresh handler is provided", () => {
    const html = renderToStaticMarkup(
      React.createElement(AuditDrawerContent, {
        events: [],
        total: 0,
        limit: 50,
        offset: 0,
        state: { kind: "ready" },
        onRefresh: vi.fn()
      })
    );
    expect(html).toContain("data-testid=\"audit-drawer-refresh\"");
    expect(html).toContain("data-testid=\"audit-drawer-actor\"");
    expect(html).toContain("data-testid=\"audit-drawer-action\"");
    expect(html).toContain("data-testid=\"audit-drawer-actor-apply\"");
    expect(html).toContain("data-testid=\"audit-drawer-action-apply\"");
  });

  it("omits the filter apply controls when no onRefresh handler is provided (read-only consumer)", () => {
    const html = renderToStaticMarkup(
      React.createElement(AuditDrawerContent, {
        events: [event({})],
        total: 1,
        limit: 50,
        offset: 0,
        state: { kind: "ready" }
      })
    );
    expect(html).not.toContain("data-testid=\"audit-drawer-refresh\"");
    expect(html).not.toContain("data-testid=\"audit-drawer-actor-apply\"");
  });
});
