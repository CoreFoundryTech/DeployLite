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
  it("uses one counter allocation per concurrent log without retrying MAX(sequence)+1", async () => {
    let nextSequence = 1;
    const insertedLogs: Array<{ sequence?: number; message?: string }> = [];
    const insert = vi.fn(() => ({
      values: (input: { sequence?: number }) => input.sequence === undefined
        ? {
            onConflictDoUpdate: () => ({
              returning: async () => [{ sequence: nextSequence++ }]
            })
          }
        : {
            returning: async () => {
              const row = logRow(input.sequence!);
              insertedLogs.push(input);
              return [row];
            }
          }
    }));
    const db = {
      insert,
      transaction: async (callback: (tx: { insert: typeof insert }) => unknown) => callback({ insert })
    } as never;
    const repository = new DbDeploymentRepository(db);

    const events = await Promise.all(Array.from({ length: 128 }, (_, index) => repository.appendAllocatedLog({
      id: `log-${index}`,
      deploymentId: "dep-1",
      level: "info",
      message: `token=dl_secret_${index}`,
      timestamp: now.toISOString(),
      redactionApplied: false,
      requestId: "req-1",
      correlationId: "req-1"
    })));

    expect(events.map((event) => event.sequence).sort((left, right) => left - right)).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
    expect(insert).toHaveBeenCalledTimes(256);
    expect(insertedLogs.every((row) => row.message?.includes("[REDACTED]") === true)).toBe(true);
  });
});
