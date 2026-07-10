import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { DeploymentCommandRow } from "../schema.js";
import { describeDeploymentCommandEventType, toDeploymentCommand } from "./deployment-commands.js";

const now = new Date("2026-01-01T00:00:00.000Z");

function deploymentCommandRow(overrides: Partial<DeploymentCommandRow> = {}): DeploymentCommandRow {
  return {
    id: "cmd_1",
    deploymentId: "dep_1",
    agentId: "agent_1",
    kind: "start",
    state: "pending",
    payload: { commitSha: "abcdef1" },
    requestedBy: null,
    requestId: "req_1",
    correlationId: "req_1",
    issuedAt: now,
    claimedAt: null,
    leaseExpiresAt: null,
    completedAt: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("deployment command bus persistence mapping", () => {
  it("maps a pending command row to the typed record with ISO timestamps", () => {
    expect(toDeploymentCommand(deploymentCommandRow())).toEqual({
      id: "cmd_1",
      deploymentId: "dep_1",
      agentId: "agent_1",
      kind: "start",
      state: "pending",
      payload: { commitSha: "abcdef1" },
      requestedBy: null,
      requestId: "req_1",
      correlationId: "req_1",
      issuedAt: "2026-01-01T00:00:00.000Z",
      claimedAt: null,
      leaseExpiresAt: null,
      completedAt: null,
      failureReason: null
    });
  });

  it("maps every documented state to the matching event type", () => {
    expect(describeDeploymentCommandEventType("pending")).toBe("deployment.command.submitted");
    expect(describeDeploymentCommandEventType("claimed")).toBe("deployment.command.claimed");
    expect(describeDeploymentCommandEventType("completed")).toBe("deployment.command.completed");
    expect(describeDeploymentCommandEventType("failed")).toBe("deployment.command.failed");
    expect(describeDeploymentCommandEventType("cancelled")).toBe("deployment.command.cancelled");
  });

  it("rejects unknown states by exhausting the switch (compile-time exhaustiveness)", () => {
    // The compiler enforces exhaustiveness on the union type; this
    // assertion documents the runtime contract: an unknown state would
    // surface as `undefined` from the helper and is treated as a
    // programming error by callers.
    expect((describeDeploymentCommandEventType as (state: string) => unknown)("unknown")).toBeUndefined();
  });

  it("guards terminal updates with command, assignment, and expected-state predicates", async () => {
    const source = await readFile(new URL("./deployment-commands.ts", import.meta.url), "utf8");
    const method = source.slice(source.indexOf("async transitionTerminal"), source.indexOf("async findActiveForDeployment"));
    expect(method).toContain("eq(deploymentCommands.id, commandId)");
    expect(method).toContain("eq(deploymentCommands.agentId, agentId)");
    expect(method).toContain("eq(deploymentCommands.state, expectedState)");
    expect(method).toContain("lte(deploymentCommands.leaseExpiresAt, new Date(condition.leaseExpiresAtNotAfter))");
    expect(method).toContain("const authoritative = await this.findById(commandId)");
  });
});
