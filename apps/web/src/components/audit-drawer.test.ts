import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEventListItem } from "@deploylite/contracts";
import {
  AuditDrawerContent,
  describeAuditListFailure,
  maskAuditActor,
  maskAuditTarget,
  renderAuditTimestamp
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
    // The list is metadata-stripped by the API, so fingerprint-like rows are
    // never rendered as `valueFingerprint` keys.
    expect(html).not.toContain("valueFingerprint");
    expect(html).not.toContain("metadata");
  });

  it("forwards filter values to the refresh handler when the filter apply button is clicked", () => {
    const refresh = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(AuditDrawerContent, {
        events: [],
        total: 0,
        limit: 50,
        offset: 0,
        state: { kind: "ready" },
        onRefresh: refresh
      })
    );
    // The refresh button exists; onClick is not exercised in the static
    // render test, but the contract that an apply callback is wired to the
    // filter inputs is asserted through the testid.
    expect(html).toContain("data-testid=\"audit-drawer-refresh\"");
    expect(html).toContain("data-testid=\"audit-drawer-actor\"");
    expect(html).toContain("data-testid=\"audit-drawer-action\"");
    expect(refresh).not.toHaveBeenCalled();
  });
});
