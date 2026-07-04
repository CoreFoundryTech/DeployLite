import Link from "next/link";
import { LogoutButton } from "../auth-controls";
import { getAuthApiBaseUrl } from "../../lib/auth-boundary";
import { createMockPlatformSnapshot, formatBytes, resolveDashboardShell } from "../../lib/scaffold-shell";
import { loadRequestAuthSession } from "../../lib/server-auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const auth = await loadRequestAuthSession();
  const snapshot = createMockPlatformSnapshot({ session: auth.kind === "authenticated" ? auth.user : null });
  const state = resolveDashboardShell(snapshot);

  if (state.kind !== "ready") {
    return <main className="shell"><section className="banner stack"><h1>{state.title}</h1><p className="muted">{state.description}</p><Link className="button" href="/">Return to sign in</Link></section></main>;
  }

  const agent = state.snapshot.agents[0];
  const resources = agent?.resourceSnapshot;

  return (
    <main className="shell stack">
      <nav className="topbar" aria-label="Primary navigation">
        <strong>DeployLite</strong>
        <div className="nav-actions">
          <Link href={`/deployments/${state.snapshot.deployments[0]?.id ?? "dep_mock_1"}`}>View deployment logs</Link>
          <LogoutButton apiBaseUrl={getAuthApiBaseUrl()} />
        </div>
      </nav>
      <section className="banner" aria-labelledby="dashboard-title">
        <span className="pill">{state.snapshot.authMode}</span>
        <h1 id="dashboard-title">Mock platform status</h1>
        <p className="muted">Signed in as {state.snapshot.session?.email}. Request {state.snapshot.requestId}. Data mirrors the API contracts and stays mock-only.</p>
      </section>
      <section className="grid" aria-label="Server status summary">
        <article className="card"><h2>Agent</h2><p>{agent?.name ?? "No agent"}</p><p className="muted">Status: {agent?.status ?? "empty"}</p></article>
        <article className="card"><h2>Heartbeat</h2><p>{agent?.lastHeartbeatAt ?? "No heartbeat"}</p><p className="muted">Freshness is calculated by the API/domain boundary.</p></article>
        <article className="card"><h2>Resources</h2><p>{resources ? `${Math.round(resources.cpuLoad * 100)}% CPU` : "No snapshot"}</p><p className="muted">{resources ? `${formatBytes(resources.memoryUsedBytes)} / ${formatBytes(resources.memoryTotalBytes)} memory` : "Waiting for heartbeat"}</p></article>
      </section>
    </main>
  );
}
