import { describe, expect, it } from "vitest";

import type { DeploymentLogRow, DeploymentRow } from "../schema.js";
import { toDeployment, toOrderedLogEvents } from "./deployment-data.js";

const now = new Date("2026-01-01T00:00:00.000Z");

function deploymentRow(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: "dep-1",
    projectId: "project-1",
    agentId: "agent-1",
    status: "running",
    commitSha: "abcdef1",
    startedAt: now,
    finishedAt: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function logRow(sequence: number): DeploymentLogRow {
  return {
    id: `log-${sequence}`,
    deploymentId: "dep-1",
    sequence,
    level: "info",
    message: `Log ${sequence}`,
    redactionApplied: true,
    requestId: "req-1",
    correlationId: "req-1",
    createdAt: new Date(now.getTime() + sequence)
  };
}

describe("deployment metadata persistence mapping", () => {
  it("maps attached deployments without manufacturing empty agent IDs", () => {
    expect(toDeployment(deploymentRow())).toEqual({
      id: "dep-1",
      projectId: "project-1",
      agentId: "agent-1",
      status: "running",
      commitSha: "abcdef1",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null
    });

    expect(toDeployment(deploymentRow({ agentId: null }))).toBeNull();
  });

  it("returns log events ordered by sequence", () => {
    expect(toOrderedLogEvents([logRow(3), logRow(1), logRow(2)]).map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});
