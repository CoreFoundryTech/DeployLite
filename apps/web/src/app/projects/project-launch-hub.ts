import type { Deployment, Project } from "@deploylite/contracts";

export type ProjectLaunchRuntime = {
  configured: boolean;
  label: string;
  detail: string;
};

export type ProjectLaunchLatest = {
  deployment: Deployment | null;
  statusLabel: string;
  statusTone: "ready" | "attention" | "muted" | "active";
};

export type ProjectLaunchNextAction = {
  label: string;
  ctaKey: "configure-runtime" | "deploy-latest" | "inspect-latest-logs";
  href: string;
};

export type ProjectLaunchSummary = {
  project: Project;
  runtime: ProjectLaunchRuntime;
  latest: ProjectLaunchLatest;
  nextAction: ProjectLaunchNextAction;
  hasLatestDeployment: boolean;
  logsHref: string | null;
  configureHref: string;
  deployHref: string;
};

/**
 * Pure helpers that turn a project + the deployment list already loaded by the
 * projects page into the readiness, latest status, and next action data used by
 * the launch-hub table. Kept side-effect free so the rendering logic can be
 * unit-tested with a handful of fixtures instead of the full page render.
 */
export function getLatestDeploymentForProject(deployments: Deployment[], projectId: string): Deployment | null {
  return deployments
    .filter((deployment) => deployment.projectId === projectId)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null;
}

export function summarizeProjectRuntime(project: Project): ProjectLaunchRuntime {
  const hasCommand = typeof project.runCommand === "string" && project.runCommand.length > 0;
  const hasPort = typeof project.port === "number" && project.port > 0 && project.port <= 65535;
  const configured = hasCommand && hasPort;

  if (configured) {
    return {
      configured: true,
      label: "Configured",
      detail: `${project.runCommand} → port ${project.port}`
    };
  }

  return {
    configured: false,
    label: "Needs command",
    detail: "Set a run command and port before triggering useful deploys."
  };
}

export function summarizeProjectLatest(deployment: Deployment | null): ProjectLaunchLatest {
  if (!deployment) {
    return { deployment: null, statusLabel: "Not run", statusTone: "muted" };
  }

  if (deployment.status === "succeeded") {
    return { deployment, statusLabel: deployment.status, statusTone: "ready" };
  }
  if (deployment.status === "failed" || deployment.status === "canceled") {
    return { deployment, statusLabel: deployment.status, statusTone: "attention" };
  }
  return { deployment, statusLabel: deployment.status, statusTone: "active" };
}

export function summarizeProjectNextAction(
  project: Project,
  latestDeployment: Deployment | null
): ProjectLaunchNextAction {
  const runtime = summarizeProjectRuntime(project);
  if (!runtime.configured) {
    return {
      label: "Configure runtime",
      ctaKey: "configure-runtime",
      href: `/projects/${project.id}#env-metadata`
    };
  }
  if (!latestDeployment) {
    return {
      label: "Deploy latest",
      ctaKey: "deploy-latest",
      href: `/projects/${project.id}#deploy-actions`
    };
  }
  return {
    label: "Inspect latest logs",
    ctaKey: "inspect-latest-logs",
    href: `/deployments/${latestDeployment.id}`
  };
}

export function summarizeProjectLaunch(project: Project, deployments: Deployment[]): ProjectLaunchSummary {
  const latestDeployment = getLatestDeploymentForProject(deployments, project.id);
  const runtime = summarizeProjectRuntime(project);
  const latest = summarizeProjectLatest(latestDeployment);
  const nextAction = summarizeProjectNextAction(project, latestDeployment);
  return {
    project,
    runtime,
    latest,
    nextAction,
    hasLatestDeployment: Boolean(latestDeployment),
    logsHref: latestDeployment ? `/deployments/${latestDeployment.id}` : null,
    configureHref: `/projects/${project.id}#env-metadata`,
    deployHref: `/projects/${project.id}#deploy-actions`
  };
}
