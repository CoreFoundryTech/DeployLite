import { eq } from "drizzle-orm";
import { redactLogMessage } from "@deploylite/config";
import type { Agent, Deployment, LogEvent, Project } from "@deploylite/contracts";
import type { AgentRepository, DeploymentRepository, ProjectRepository } from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { agents, deploymentLogs, deployments, projects } from "../schema.js";

export class DbAgentRepository implements AgentRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async save(agent: Agent): Promise<Agent> {
    const [row] = await this.db
      .insert(agents)
      .values({
        id: agent.id,
        name: agent.name,
        endpoint: agent.endpoint,
        status: agent.status,
        lastHeartbeatAt: agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt) : null,
        resourceSnapshot: agent.resourceSnapshot
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: {
          name: agent.name,
          endpoint: agent.endpoint,
          status: agent.status,
          lastHeartbeatAt: agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt) : null,
          resourceSnapshot: agent.resourceSnapshot,
          updatedAt: new Date()
        }
      })
      .returning();

    if (!row) throw new Error("Failed to save agent");
    return toAgent(row);
  }

  async findById(id: string): Promise<Agent | null> {
    const [row] = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return row ? toAgent(row) : null;
  }

  async list(): Promise<Agent[]> {
    const rows = await this.db.select().from(agents);
    return rows.map(toAgent);
  }
}

export class DbProjectRepository implements ProjectRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async save(project: Project): Promise<Project> {
    const [row] = await this.db
      .insert(projects)
      .values({ id: project.id, name: project.name, repoUrl: project.repoUrl, defaultBranch: project.defaultBranch })
      .onConflictDoUpdate({
        target: projects.id,
        set: { name: project.name, repoUrl: project.repoUrl, defaultBranch: project.defaultBranch, updatedAt: new Date() }
      })
      .returning();

    if (!row) throw new Error("Failed to save project");
    return { id: row.id, name: row.name, repoUrl: row.repoUrl, defaultBranch: row.defaultBranch };
  }

  async list(): Promise<Project[]> {
    const rows = await this.db.select().from(projects);
    return rows.map((row) => ({ id: row.id, name: row.name, repoUrl: row.repoUrl, defaultBranch: row.defaultBranch }));
  }
}

export class DbDeploymentRepository implements DeploymentRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async save(deployment: Deployment): Promise<Deployment> {
    const [row] = await this.db
      .insert(deployments)
      .values({
        id: deployment.id,
        projectId: deployment.projectId,
        agentId: deployment.agentId,
        status: deployment.status,
        commitSha: deployment.commitSha,
        startedAt: new Date(deployment.startedAt),
        finishedAt: deployment.finishedAt ? new Date(deployment.finishedAt) : null
      })
      .returning();

    if (!row) throw new Error("Failed to save deployment");
    return toDeployment(row);
  }

  async findById(id: string): Promise<Deployment | null> {
    const [row] = await this.db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
    return row ? toDeployment(row) : null;
  }

  async appendLog(event: LogEvent): Promise<LogEvent> {
    const [row] = await this.db
      .insert(deploymentLogs)
      .values({
        id: event.id,
        deploymentId: event.deploymentId,
        sequence: event.sequence,
        level: event.level,
        message: redactLogMessage(event.message),
        redactionApplied: true,
        requestId: event.requestId,
        correlationId: event.correlationId
      })
      .returning();

    if (!row) throw new Error("Failed to append deployment log");
    return toLogEvent(row);
  }

  async listLogs(deploymentId: string, afterSequence = -1): Promise<LogEvent[]> {
    const rows = await this.db.select().from(deploymentLogs).where(eq(deploymentLogs.deploymentId, deploymentId));
    return rows.filter((row) => row.sequence > afterSequence).map(toLogEvent);
  }
}

function toAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    status: row.status === "online" || row.status === "stale" ? row.status : "offline",
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    resourceSnapshot: toResourceSnapshot(row.resourceSnapshot)
  };
}

function toResourceSnapshot(value: Record<string, unknown> | null): Agent["resourceSnapshot"] {
  if (!value) return null;

  const { cpuLoad, memoryUsedBytes, memoryTotalBytes, diskUsedBytes, diskTotalBytes } = value;
  if (
    typeof cpuLoad === "number" &&
    typeof memoryUsedBytes === "number" &&
    typeof memoryTotalBytes === "number" &&
    typeof diskUsedBytes === "number" &&
    typeof diskTotalBytes === "number"
  ) {
    return { cpuLoad, memoryUsedBytes, memoryTotalBytes, diskUsedBytes, diskTotalBytes };
  }

  return null;
}

function toDeployment(row: typeof deployments.$inferSelect): Deployment {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId ?? "",
    status: row.status === "running" || row.status === "succeeded" || row.status === "failed" || row.status === "canceled" ? row.status : "queued",
    commitSha: row.commitSha,
    startedAt: row.startedAt?.toISOString() ?? row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null
  };
}

function toLogEvent(row: typeof deploymentLogs.$inferSelect): LogEvent {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    sequence: row.sequence,
    level: row.level === "debug" || row.level === "warn" || row.level === "error" ? row.level : "info",
    message: row.message,
    timestamp: row.createdAt.toISOString(),
    redactionApplied: row.redactionApplied,
    requestId: row.requestId,
    correlationId: row.correlationId
  };
}
