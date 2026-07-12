import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { redactLogMessage } from "@deploylite/config";
import type { Agent, Deployment, LogEvent, Project } from "@deploylite/contracts";
import type { AgentRepository, DeploymentRepository, ProjectRepository } from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { agents, deploymentLogSequences, deploymentLogs, deployments, projects } from "../schema.js";


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
      .values({
        id: project.id,
        name: project.name,
        repoUrl: project.repoUrl,
        defaultBranch: project.defaultBranch,
        buildCommand: project.buildCommand,
        runCommand: project.runCommand,
        port: project.port,
        description: project.description,
        imageTag: project.imageTag
      })
      .onConflictDoUpdate({
        target: projects.id,
        set: {
          name: project.name,
          repoUrl: project.repoUrl,
          defaultBranch: project.defaultBranch,
          buildCommand: project.buildCommand,
          runCommand: project.runCommand,
          port: project.port,
          description: project.description,
          imageTag: project.imageTag,
          updatedAt: new Date()
        }
      })
      .returning();

    if (!row) throw new Error("Failed to save project");
    return toProject(row);
  }

  async list(): Promise<Project[]> {
    const rows = await this.db.select().from(projects);
    return rows.map(toProject);
  }

  async findById(id: string): Promise<Project | null> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return row ? toProject(row) : null;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
    return result.length > 0;
  }
}

function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    buildCommand: row.buildCommand,
    runCommand: row.runCommand,
    port: row.port,
    description: row.description,
    imageTag: row.imageTag
  };
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
      .onConflictDoUpdate({
        target: deployments.id,
        set: {
          projectId: deployment.projectId,
          agentId: deployment.agentId,
          status: deployment.status,
          commitSha: deployment.commitSha,
          startedAt: new Date(deployment.startedAt),
          finishedAt: deployment.finishedAt ? new Date(deployment.finishedAt) : null,
          updatedAt: new Date()
        }
      })
      .returning();

    if (!row) throw new Error("Failed to save deployment");
    const saved = toDeployment(row);
    if (!saved) throw new Error("Failed to save attached deployment");
    return saved;
  }

  async saveWithLogIfStatus(deployment: Deployment, expectedStatus: Deployment["status"], event: Omit<LogEvent, "sequence">): Promise<Deployment | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(deployments).set({ status: deployment.status, finishedAt: deployment.finishedAt ? new Date(deployment.finishedAt) : null, updatedAt: new Date() })
        .where(and(eq(deployments.id, deployment.id), eq(deployments.status, expectedStatus))).returning();
      if (!row) return null;
      const [allocation] = await tx.insert(deploymentLogSequences).values({ deploymentId: event.deploymentId, nextSequence: 2 })
        .onConflictDoUpdate({ target: deploymentLogSequences.deploymentId, set: { nextSequence: sql`${deploymentLogSequences.nextSequence} + 1` } })
        .returning({ sequence: sql<number>`${deploymentLogSequences.nextSequence} - 1` });
      if (!allocation) throw new Error("Failed to allocate deployment log sequence");
      const [log] = await tx.insert(deploymentLogs).values({ ...event, sequence: allocation.sequence, message: redactLogMessage(event.message), redactionApplied: true }).returning();
      if (!log) throw new Error("Failed to append deployment log");
      const saved = toDeployment(row);
      if (!saved) throw new Error("Failed to save attached deployment");
      return saved;
    });
  }

  async rollbackTerminalProjection(previous: Deployment, projected: Deployment, eventId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.delete(deploymentLogs).where(and(eq(deploymentLogs.id, eventId), eq(deploymentLogs.deploymentId, projected.id)));
      const [restored] = await tx.update(deployments).set({
        status: previous.status,
        finishedAt: previous.finishedAt ? new Date(previous.finishedAt) : null,
        updatedAt: new Date()
      }).where(and(
        eq(deployments.id, projected.id),
        eq(deployments.status, projected.status),
        projected.finishedAt ? eq(deployments.finishedAt, new Date(projected.finishedAt)) : isNull(deployments.finishedAt)
      )).returning({ id: deployments.id });
      if (!restored) return false;
      return true;
    });
  }

  async findById(id: string): Promise<Deployment | null> {
    const [row] = await this.db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
    return row ? toDeployment(row) : null;
  }

  async list(): Promise<Deployment[]> {
    const rows = await this.db.select().from(deployments).where(isNotNull(deployments.agentId)).orderBy(asc(deployments.startedAt), asc(deployments.createdAt));
    return rows.map(toDeployment).filter((deployment): deployment is Deployment => deployment !== null);
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

  async appendAllocatedLog(event: Omit<LogEvent, "sequence">): Promise<LogEvent> {
    // PostgreSQL serializes conflicting UPSERTs on this one counter row. This
    // avoids MAX(sequence)+1 and its bounded-retry failure mode under load.
    const [allocation] = await this.db
      .insert(deploymentLogSequences)
      .values({ deploymentId: event.deploymentId, nextSequence: 2 })
      .onConflictDoUpdate({
        target: deploymentLogSequences.deploymentId,
        set: { nextSequence: sql`${deploymentLogSequences.nextSequence} + 1` }
      })
      .returning({ sequence: sql<number>`${deploymentLogSequences.nextSequence} - 1` });

    if (!allocation) throw new Error("Failed to allocate deployment log sequence");
    return this.appendLog({ ...event, sequence: allocation.sequence });
  }

  async listLogs(deploymentId: string, afterSequence = -1): Promise<LogEvent[]> {
    const rows = await this.db.select().from(deploymentLogs).where(eq(deploymentLogs.deploymentId, deploymentId)).orderBy(asc(deploymentLogs.sequence));
    return toOrderedLogEvents(rows.filter((row) => row.sequence > afterSequence));
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

export function toDeployment(row: typeof deployments.$inferSelect): Deployment | null {
  if (!row.agentId) {
    return null;
  }

  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    status: row.status === "running" || row.status === "succeeded" || row.status === "failed" || row.status === "canceled" ? row.status : "queued",
    commitSha: row.commitSha,
    startedAt: row.startedAt?.toISOString() ?? row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null
  };
}

export function toLogEvent(row: typeof deploymentLogs.$inferSelect): LogEvent {
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

export function toOrderedLogEvents(rows: Array<typeof deploymentLogs.$inferSelect>): LogEvent[] {
  return [...rows].sort((left, right) => left.sequence - right.sequence).map(toLogEvent);
}
