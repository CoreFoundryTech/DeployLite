import type { Agent, AgentHeartbeat, Deployment, LogEvent, Project, ScaffoldUser } from "@deploylite/contracts";
import { redactLogMessage } from "@deploylite/config";

export type AuditEvent = {
  id: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  correlationId: string;
  timestamp: string;
};

export type AgentRepository = {
  save(agent: Agent): Promise<Agent>;
  findById(id: string): Promise<Agent | null>;
  list(): Promise<Agent[]>;
};

export type DeploymentRepository = {
  save(deployment: Deployment): Promise<Deployment>;
  findById(id: string): Promise<Deployment | null>;
  appendLog(event: LogEvent): Promise<LogEvent>;
  listLogs(deploymentId: string, afterSequence?: number): Promise<LogEvent[]>;
};

export type ProjectRepository = {
  save(project: Project): Promise<Project>;
  list(): Promise<Project[]>;
};

export type UserRepository = {
  findByEmail(email: string): Promise<ScaffoldUser | null>;
};

const STALE_AFTER_MS = 60_000;

export class InMemoryAgentRepository implements AgentRepository {
  readonly #agents = new Map<string, Agent>();

  async save(agent: Agent): Promise<Agent> {
    this.#agents.set(agent.id, structuredClone(agent));
    return agent;
  }

  async findById(id: string): Promise<Agent | null> {
    return this.#agents.get(id) ?? null;
  }

  async list(): Promise<Agent[]> {
    return [...this.#agents.values()];
  }
}

export class AgentStatusService {
  constructor(private readonly agents: AgentRepository) {}

  async recordHeartbeat(heartbeat: AgentHeartbeat): Promise<Agent> {
    const existing = await this.agents.findById(heartbeat.agentId);
    if (!existing) {
      throw new Error("Agent is not registered");
    }

    const updated: Agent = {
      ...existing,
      status: "online",
      lastHeartbeatAt: heartbeat.observedAt,
      resourceSnapshot: heartbeat.resourceSnapshot
    };
    return this.agents.save(updated);
  }

  markStale(agent: Agent, now = new Date()): Agent {
    if (!agent.lastHeartbeatAt) {
      return { ...agent, status: "offline" };
    }

    const ageMs = now.getTime() - new Date(agent.lastHeartbeatAt).getTime();
    return ageMs > STALE_AFTER_MS ? { ...agent, status: "stale" } : agent;
  }
}

export class InMemoryDeploymentRepository implements DeploymentRepository {
  readonly #deployments = new Map<string, Deployment>();
  readonly #logs = new Map<string, LogEvent[]>();

  async save(deployment: Deployment): Promise<Deployment> {
    const current = this.#deployments.get(deployment.id);
    if (current) {
      throw new Error("Deployment records are immutable in the scaffold domain");
    }
    this.#deployments.set(deployment.id, structuredClone(deployment));
    return deployment;
  }

  async findById(id: string): Promise<Deployment | null> {
    return this.#deployments.get(id) ?? null;
  }

  async appendLog(event: LogEvent): Promise<LogEvent> {
    const safeEvent = { ...event, message: redactLogMessage(event.message), redactionApplied: true };
    const events = this.#logs.get(event.deploymentId) ?? [];
    if (events.some((existing) => existing.sequence === event.sequence)) {
      throw new Error("Log sequences are immutable and unique per deployment");
    }
    this.#logs.set(event.deploymentId, [...events, safeEvent]);
    return safeEvent;
  }

  async listLogs(deploymentId: string, afterSequence = -1): Promise<LogEvent[]> {
    return (this.#logs.get(deploymentId) ?? []).filter((event) => event.sequence > afterSequence);
  }
}
