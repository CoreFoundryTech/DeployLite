import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { RuntimeConfigurationCard, submitRuntimeActivation } from "./runtime-configuration-card.js";

describe("runtime configuration UI", () => {
  it("renders labeled secret inputs and an accessible status region", () => {
    const html = renderToStaticMarkup(React.createElement(RuntimeConfigurationCard, { projectId: "project-1", apiBaseUrl: "https://api.example.test", cookieHeader: "deploylite_session=opaque" }));
    expect(html).toContain("id=\"runtime-domain\"");
    expect(html).toContain("type=\"password\"");
    expect(html).toContain("role=\"status\"");
  });

  it("surfaces the unavailable executor state without claiming activation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { activation: { id: "runtime_1", status: "capability_unavailable" } } }), { status: 200 }));
    await expect(submitRuntimeActivation("project-1", "https://api.example.test", "deploylite_session=opaque", fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({ state: "unavailable" });
  });
});
