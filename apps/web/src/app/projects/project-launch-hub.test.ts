import type { Project } from "@deploylite/contracts";
import { describe, expect, it } from "vitest";

import { summarizeProjectNextAction, summarizeProjectRuntime } from "./project-launch-hub";

const createProject = (port: number): Project => ({
  id: "project-1",
  name: "Example project",
  repoUrl: "https://github.com/example/project",
  defaultBranch: "main",
  buildCommand: null,
  runCommand: "pnpm start",
  port,
  description: null,
  imageTag: null
});

describe("summarizeProjectRuntime", () => {
  it("treats port 65535 as configured", () => {
    expect(summarizeProjectRuntime(createProject(65535))).toEqual({
      configured: true,
      label: "Configured",
      detail: "pnpm start → port 65535"
    });
  });

  it("treats port 65536 as unconfigured and directs users to configure runtime", () => {
    const project = createProject(65536);

    expect(summarizeProjectRuntime(project)).toEqual({
      configured: false,
      label: "Needs command",
      detail: "Set a run command and port before triggering useful deploys."
    });
    expect(summarizeProjectNextAction(project, null)).toEqual({
      label: "Configure runtime",
      ctaKey: "configure-runtime",
      href: "/projects/project-1#env-metadata"
    });
  });
});
