import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { ProjectDeleteDialog, runProjectDelete } from "./project-delete-dialog.js";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() })
}));

const baseProps = {
  projectId: "project-1",
  projectName: "Demo API",
  apiBaseUrl: "https://api.example.test",
  cookieHeader: "deploylite_session=opaque"
};

describe("runProjectDelete", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns deleted when the API confirms the removal", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: { removed: true, audit: { action: "project.delete", targetType: "project", targetId: "project-1" } },
      error: null,
      requestId: "req_delete_1"
    }), { status: 200 }));

    const result = await runProjectDelete({ ...baseProps, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.kind).toBe("deleted");
    expect(result.redirectPath).toBe("/projects");
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe("https://api.example.test/api/v1/projects/project-1");
    expect(calledInit.method).toBe("DELETE");
  });

  it("returns not_found when the API responds 404", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: null,
      error: { code: "NOT_FOUND", message: "Project not found.", correlationId: "req_delete_404" },
      requestId: "req_delete_404"
    }), { status: 404 }));

    const result = await runProjectDelete({ ...baseProps, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.kind).toBe("error");
    expect(result.redirectPath).toBeNull();
    if (result.kind === "error") {
      expect(result.message).toBe("This project is already gone. Reload the projects list.");
    }
  });

  it("returns rejected when the API responds with a 4xx other than 404", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: null,
      error: { code: "FORBIDDEN", message: "Forbidden.", correlationId: "req_delete_403" },
      requestId: "req_delete_403"
    }), { status: 403 }));

    const result = await runProjectDelete({ ...baseProps, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.kind).toBe("error");
    expect(result.redirectPath).toBeNull();
    if (result.kind === "error") {
      expect(result.message).toBe("You do not have permission to delete this project.");
    }
  });

  it("returns unconfigured when the API base URL is missing", async () => {
    const result = await runProjectDelete({ ...baseProps, apiBaseUrl: null });

    expect(result.kind).toBe("error");
    expect(result.redirectPath).toBeNull();
    if (result.kind === "error") {
      expect(result.message).toBe("Configure DEPLOYLITE_WEB_API_BASE_URL before deleting projects.");
    }
  });

  it("returns unreachable when the API call throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });

    const result = await runProjectDelete({ ...baseProps, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("The local API is unreachable. Start the API and try again.");
    }
  });
});

describe("ProjectDeleteDialog markup", () => {
  it("renders a destructive trigger button with the configured label", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectDeleteDialog, baseProps));

    expect(html).toContain("Delete project");
    expect(html).toContain("data-testid=\"project-delete-trigger\"");
    expect(html).toContain("data-slot=\"dialog-trigger\"");
  });

  it("accepts a custom trigger element (e.g. a row-level action button) and forwards the project id", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectDeleteDialog, {
      ...baseProps,
      triggerLabel: "Remove Demo",
      trigger: React.createElement("button", { "data-testid": "custom-delete-trigger", "data-project-id": baseProps.projectId }, "Remove Demo")
    }));

    expect(html).toContain("data-testid=\"custom-delete-trigger\"");
    expect(html).toContain(`data-project-id="${baseProps.projectId}"`);
  });
});
