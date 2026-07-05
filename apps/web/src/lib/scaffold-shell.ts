import type { Agent, Deployment, LogEvent, Project, SafeAuthUserDto } from "@deploylite/contracts";

export type ConnectionState = "loading" | "ready" | "empty" | "disconnected";

export type DeploymentLogView = {
  deployment: Deployment | null;
  events: LogEvent[];
  streamState: ConnectionState;
  lastEventId: number | null;
};

export type PlatformSnapshot = {
  session: SafeAuthUserDto | null;
  agents: Agent[];
  projects: Project[];
  deployments: Deployment[];
  logView: DeploymentLogView;
  state: ConnectionState;
  requestId: string;
  authMode: "cookie-session";
};

export type DashboardShellState =
  | { kind: "blocked"; title: string; description: string }
  | { kind: "loading"; title: string; description: string }
  | { kind: "empty"; title: string; description: string }
  | { kind: "disconnected"; title: string; description: string; lastEventId: number | null }
  | { kind: "ready"; snapshot: PlatformSnapshot };

export const scaffoldSession: SafeAuthUserDto = {
  id: "scaffold-user",
  email: "operator@example.test",
  role: "operator",
  status: "active"
};

const mockAgent: Agent = {
  id: "agent_mock_1",
  name: "Mock VPS Agent",
  endpoint: "https://agent.example.test",
  status: "online",
  lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
  resourceSnapshot: {
    cpuLoad: 0.24,
    memoryUsedBytes: 512,
    memoryTotalBytes: 2048,
    diskUsedBytes: 10_000,
    diskTotalBytes: 100_000
  }
};

const mockProject: Project = {
  id: "project_mock_1",
  name: "DeployLite Mock Project",
  repoUrl: "https://github.com/CoreFoundryTech/DeployLite",
  defaultBranch: "main",
  buildCommand: "pnpm build",
  runCommand: "pnpm start",
  port: 3000
};

const mockDeployment: Deployment = {
  id: "dep_mock_1",
  projectId: mockProject.id,
  agentId: mockAgent.id,
  status: "running",
  commitSha: "abcdef1",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null
};

const mockLogs: LogEvent[] = [
  {
    id: "log_1",
    deploymentId: mockDeployment.id,
    sequence: 1,
    level: "info",
    message: "Preparing deployment",
    timestamp: "2026-01-01T00:00:00.000Z",
    redactionApplied: true,
    requestId: "web_mock_req_1",
    correlationId: "web_mock_req_1"
  },
  {
    id: "log_2",
    deploymentId: mockDeployment.id,
    sequence: 2,
    level: "info",
    message: "Using token [REDACTED] for mock fixture",
    timestamp: "2026-01-01T00:00:01.000Z",
    redactionApplied: true,
    requestId: "web_mock_req_1",
    correlationId: "web_mock_req_1"
  }
];

export function createMockPlatformSnapshot(overrides: Partial<PlatformSnapshot> = {}): PlatformSnapshot {
  const logView = overrides.logView ?? {
    deployment: mockDeployment,
    events: mockLogs,
    streamState: "ready",
    lastEventId: mockLogs.at(-1)?.sequence ?? null
  };

  return {
    session: scaffoldSession,
    agents: [mockAgent],
    projects: [mockProject],
    deployments: [mockDeployment],
    logView,
    state: "ready",
    requestId: "web_mock_req_1",
    authMode: "cookie-session",
    ...overrides
  };
}

export function resolveDashboardShell(snapshot: PlatformSnapshot): DashboardShellState {
  if (!snapshot.session) {
    return {
      kind: "blocked",
      title: "Sign in required",
      description: "This shell requires the cookie-backed API session from /auth/me. It is still an MVP boundary, not a production auth claim."
    };
  }

  if (snapshot.state === "loading") {
    return { kind: "loading", title: "Loading platform status", description: "Fetching the mock control-plane status after session validation." };
  }

  if (snapshot.state === "disconnected") {
    return {
      kind: "disconnected",
      title: "Log stream disconnected",
      description: "The UI can resume from the last received SSE event ID when the API is connected.",
      lastEventId: snapshot.logView.lastEventId
    };
  }

  if (snapshot.agents.length === 0 && snapshot.deployments.length === 0) {
    return { kind: "empty", title: "No mock infrastructure yet", description: "Register a mock agent before deployment data appears here." };
  }

  return { kind: "ready", snapshot };
}

export function formatBytes(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}
