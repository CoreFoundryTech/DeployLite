import { describe, expect, it, vi } from "vitest";

import type { DeploymentLogRow, DeploymentRow } from "../schema.js";
import { DbDeploymentRepository, toDeployment, toOrderedLogEvents } from "./deployment-data.js";

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

describe("PostgreSQL deployment log allocation", () => {
  it("retries a PostgreSQL unique conflict with the next allocated sequence without leaking the message", async () => {
    const values = vi.fn();
    const insert = vi.fn()
      .mockReturnValueOnce({ values: (input: unknown) => (values(input), { returning: async () => { throw Object.assign(new Error("unique constraint"), { code: "23505" }); } }) })
      .mockReturnValueOnce({ values: (input: { sequence: number }) => (values(input), { returning: async () => [logRow(input.sequence)] }) });
    let reads = 0;
    const db = { insert, select: () => ({ from: () => ({ where: () => ({ orderBy: async () => reads++ ? [logRow(1)] : [] }) }) }) } as never;
    const result = await new DbDeploymentRepository(db).appendAllocatedLog({ id: "log-new", deploymentId: "dep-1", level: "info", message: "token=dl_supersecret", timestamp: now.toISOString(), redactionApplied: true, requestId: "req-1", correlationId: "req-1" });
    expect(result.sequence).toBe(2);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(values.mock.calls.map(([input]) => (input as { sequence: number }).sequence)).toEqual([1, 2]);
    expect(JSON.stringify(values.mock.calls)).not.toContain("supersecret");
  });
});
