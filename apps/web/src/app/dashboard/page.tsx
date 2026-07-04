import Link from "next/link";
import React from "react";
import { LogoutButton } from "../auth-controls";
import { getAuthApiBaseUrl } from "../../lib/auth-boundary";
import { formatBytes } from "../../lib/scaffold-shell";
import { loadRequestAuthSession, loadRequestDashboardMetadata } from "../../lib/server-auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const auth = await loadRequestAuthSession();

  if (auth.kind !== "authenticated") {
    return <main className="shell"><section className="banner stack" aria-labelledby="dashboard-title"><h1 id="dashboard-title">Sign in required</h1><p className="muted">The dashboard needs a valid local API session before metadata can be loaded. Complete first-admin setup if prompted, then sign in.</p><Link className="button" href="/">Return to sign in</Link></section></main>;
  }

  const loadingCopy = "Loading authenticated local metadata from the API. This check does not start Docker, VPS, Dokploy, Traefik, ACME, DNS, domain, or deployment work.";

  const metadata = await loadRequestDashboardMetadata();

  if (metadata.kind === "error") {
    return <main className="shell"><section className="banner stack" aria-labelledby="dashboard-title"><span className="pill">Local metadata</span><h1 id="dashboard-title">Unable to load platform data</h1><p className="alert-message" role="alert">The API rejected or could not provide dashboard metadata. Reason: {metadata.reason}.</p><p className="muted">Retry after the local API is running and the session is valid. Do not start Docker, VPS, Dokploy, Traefik, ACME, DNS, domain, or deployment work for this state.</p><Link className="button" href="/dashboard">Retry dashboard</Link></section></main>;
  }

  const { agents, deployments, projects } = metadata.data;
  const agent = agents[0];
  const resources = agent?.resourceSnapshot;
  const latestDeployment = deployments[0];

  if (agents.length === 0 && deployments.length === 0 && projects.length === 0) {
    return (
      <main className="shell stack">
        <nav className="topbar" aria-label="Primary navigation">
          <strong>DeployLite</strong>
          <div className="nav-actions"><LogoutButton apiBaseUrl={getAuthApiBaseUrl()} /></div>
        </nav>
        <section className="banner stack" aria-labelledby="dashboard-title">
          <span className="pill">cookie-session</span>
          <h1 id="dashboard-title">No platform metadata yet</h1>
          <p className="muted">Signed in as {auth.user.email}. Create local projects, agents, or deployment records through the existing authenticated API paths before dashboard data appears.</p>
          <p className="status-message" role="status">Deployment execution, VPS, Dokploy, Docker socket, Traefik, ACME, DNS, and domain work are intentionally out of scope for this local MVP screen.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell stack">
      <nav className="topbar" aria-label="Primary navigation">
        <strong>DeployLite</strong>
        <div className="nav-actions">
          {latestDeployment ? <Link href={`/deployments/${latestDeployment.id}`}>View deployment logs</Link> : <span className="muted">No deployments yet</span>}
          <LogoutButton apiBaseUrl={getAuthApiBaseUrl()} />
        </div>
      </nav>
      <section className="banner" aria-labelledby="dashboard-title">
        <span className="pill">cookie-session</span>
        <h1 id="dashboard-title">Platform status</h1>
        <p className="muted">Signed in as {auth.user.email}. Request {metadata.requestId}. Data is loaded from authenticated API metadata endpoints.</p>
        <p className="status-message" role="status">{loadingCopy}</p>
      </section>
      <section className="grid" aria-label="Server status summary">
        <article className="card"><h2>Agent</h2><p>{agent?.name ?? "No agent"}</p><p className="muted">Status: {agent?.status ?? "empty"}</p></article>
        <article className="card"><h2>Projects</h2><p>{projects.length}</p><p className="muted">Default branch: {projects[0]?.defaultBranch ?? "not configured"}</p></article>
        <article className="card"><h2>Resources</h2><p>{resources ? `${Math.round(resources.cpuLoad * 100)}% CPU` : "No snapshot"}</p><p className="muted">{resources ? `${formatBytes(resources.memoryUsedBytes)} / ${formatBytes(resources.memoryTotalBytes)} memory` : "Waiting for heartbeat"}</p></article>
      </section>
    </main>
  );
}
