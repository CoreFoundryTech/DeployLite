import { describe, expect, it } from "vitest";

import { authenticateLocalUser, InMemoryDeploymentRepository, type AgentRepository, type AuthUser, type AuthUserRepository, type PasswordHasher, type ProjectRepository } from "./index.js";

const activeUser: AuthUser = {
  id: "user-1",
  email: "admin@example.test",
  emailNormalized: "admin@example.test",
  passwordHash: "stored-hash",
  role: "admin",
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z")
};

function users(user: AuthUser | null): AuthUserRepository {
  return {
    async findByEmail() {
      return user;
    },
    async findById() {
      return user;
    },
    async count() {
      return user ? 1 : 0;
    },
    async createInitialAdmin() {
      throw new Error("not used");
    }
  };
}

function hasher(matches: boolean): PasswordHasher {
  return {
    async hash() {
      return "stored-hash";
    },
    async verify() {
      return matches;
    }
  };
}

describe("authenticateLocalUser", () => {
  it("returns API-safe user metadata for valid active users", async () => {
    const result = await authenticateLocalUser(users(activeUser), hasher(true), "admin@example.test", "valid-password");

    expect(result).toEqual({
      id: activeUser.id,
      email: activeUser.email,
      emailNormalized: activeUser.emailNormalized,
      role: activeUser.role,
      status: activeUser.status,
      createdAt: activeUser.createdAt,
      updatedAt: activeUser.updatedAt
    });
    expect(result).not.toHaveProperty("passwordHash");
  });

  it("rejects invalid passwords", async () => {
    await expect(authenticateLocalUser(users(activeUser), hasher(false), "admin@example.test", "wrong-password")).resolves.toBeNull();
  });

  it("rejects disabled users before restoring identity", async () => {
    await expect(
      authenticateLocalUser(users({ ...activeUser, status: "disabled" }), hasher(true), "admin@example.test", "valid-password")
    ).resolves.toBeNull();
  });

  it("rejects unsupported persisted roles", async () => {
    await expect(
      authenticateLocalUser(users({ ...activeUser, role: "owner" as "admin" }), hasher(true), "admin@example.test", "valid-password")
    ).rejects.toThrow("Unsupported canonical role");
  });
});

describe("getBootstrapStatus", () => {
  it("reports setup required when no users exist", async () => {
    const { getBootstrapStatus } = await import("./index.js");

    await expect(getBootstrapStatus(users(null))).resolves.toEqual({ setupRequired: true });
  });

  it("locks setup when users already exist", async () => {
    const { getBootstrapStatus } = await import("./index.js");

    await expect(getBootstrapStatus(users(activeUser))).resolves.toEqual({ setupRequired: false });
  });
});

describe("metadata repository contracts", () => {
  it("support project list/read and agent list/read fakes for dashboard routes", async () => {
    const projects: ProjectRepository = {
      async save(project) {
        return project;
      },
      async findById(id) {
        return id === "project-1" ? { id, name: "Project", repoUrl: "https://github.com/example/project", defaultBranch: "main" } : null;
      },
      async list() {
        return [{ id: "project-1", name: "Project", repoUrl: "https://github.com/example/project", defaultBranch: "main" }];
      }
    };
    const agents: AgentRepository = {
      async save(agent) {
        return agent;
      },
      async findById(id) {
        return id === "agent-1" ? { id, name: "Agent", endpoint: "https://agent.example.test", status: "online", lastHeartbeatAt: null, resourceSnapshot: null } : null;
      },
      async list() {
        return [{ id: "agent-1", name: "Agent", endpoint: "https://agent.example.test", status: "online", lastHeartbeatAt: null, resourceSnapshot: null }];
      }
    };

    await expect(projects.findById("project-1")).resolves.toMatchObject({ id: "project-1" });
    await expect(projects.list()).resolves.toHaveLength(1);
    await expect(agents.findById("agent-1")).resolves.toMatchObject({ id: "agent-1" });
    await expect(agents.list()).resolves.toHaveLength(1);
  });

  it("supports deployment list and ordered log fakes for dashboard and detail routes", async () => {
    const deployments = new InMemoryDeploymentRepository();
    await deployments.save({ id: "dep-1", projectId: "project-1", agentId: "agent-1", status: "running", commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null });
    await deployments.appendLog({ id: "log-1", deploymentId: "dep-1", sequence: 1, level: "info", message: "Started", timestamp: "2026-01-01T00:00:00.000Z", redactionApplied: false, requestId: "req-1", correlationId: "req-1" });

    await expect(deployments.list()).resolves.toHaveLength(1);
    await expect(deployments.findById("dep-1")).resolves.toMatchObject({ id: "dep-1" });
    await expect(deployments.listLogs("dep-1")).resolves.toEqual([expect.objectContaining({ sequence: 1 })]);
  });
});
