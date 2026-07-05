import { describe, expect, it } from "vitest";
import { normalizeProjectConfigUpdate } from "./project-config-edit.js";

const currentProject = {
  name: "DeployLite",
  repoUrl: "https://github.com/CoreFoundryTech/DeployLite",
  defaultBranch: "main",
  buildCommand: "pnpm build",
  runCommand: "node server.js",
  port: 3000
};

describe("normalizeProjectConfigUpdate", () => {
  it("trims changed required fields and omits unchanged fields", () => {
    const result = normalizeProjectConfigUpdate(currentProject, {
      name: " DeployLite Web ",
      repoUrl: "https://github.com/CoreFoundryTech/DeployLite",
      defaultBranch: " main ",
      buildCommand: "pnpm build",
      runCommand: " node server.js ",
      port: "3000"
    });

    expect(result).toEqual({ ok: true, payload: { name: "DeployLite Web" } });
  });

  it("normalizes empty optional runtime inputs to explicit null clears", () => {
    const result = normalizeProjectConfigUpdate(currentProject, {
      name: "DeployLite",
      repoUrl: currentProject.repoUrl,
      defaultBranch: "main",
      buildCommand: " ",
      runCommand: "",
      port: ""
    });

    expect(result).toEqual({ ok: true, payload: { buildCommand: null, runCommand: null, port: null } });
  });

  it("rejects invalid required fields and invalid port values without returning a payload", () => {
    expect(normalizeProjectConfigUpdate(currentProject, { ...currentProject, name: " " })).toEqual({ ok: false, message: "Project name is required." });
    expect(normalizeProjectConfigUpdate(currentProject, { ...currentProject, repoUrl: "not-a-url" })).toEqual({ ok: false, message: "Repository URL must be a valid URL." });
    expect(normalizeProjectConfigUpdate(currentProject, { ...currentProject, defaultBranch: "" })).toEqual({ ok: false, message: "Default branch is required." });
    expect(normalizeProjectConfigUpdate(currentProject, { ...currentProject, port: "70000" })).toEqual({ ok: false, message: "Port must be a whole number between 1 and 65535." });
  });
});
