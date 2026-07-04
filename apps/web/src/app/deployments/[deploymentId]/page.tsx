import Link from "next/link";
import React from "react";
import { loadRequestAuthSession, loadRequestDeploymentLogMetadata } from "../../../lib/server-auth";

export const dynamic = "force-dynamic";

export default async function DeploymentLogsPage({ params }: { params: Promise<{ deploymentId: string }> }) {
  const { deploymentId } = await params;
  const auth = await loadRequestAuthSession();

  if (auth.kind !== "authenticated") {
    return <main className="shell"><section className="banner stack"><h1>Sign in required</h1><p className="muted">Deployment logs need a valid API session before metadata can be loaded.</p><Link className="button" href="/">Return to sign in</Link></section></main>;
  }

  const logView = await loadRequestDeploymentLogMetadata(deploymentId);

  if (logView.kind === "error") {
    return <main className="shell"><section className="banner stack"><h1>Unable to load deployment logs</h1><p className="muted">The API rejected or could not provide deployment metadata. Reason: {logView.reason}.</p><Link className="button" href="/dashboard">Back to dashboard</Link></section></main>;
  }

  if (!logView.data.deployment) {
    return <main className="shell"><section className="banner stack"><h1>Deployment not found</h1><p className="muted">No deployment metadata exists for {deploymentId}.</p><Link className="button" href="/dashboard">Back to dashboard</Link></section></main>;
  }

  const lastEventId = logView.data.events.at(-1)?.sequence ?? null;

  return (
    <main className="shell stack">
      <nav className="topbar" aria-label="Deployment navigation">
        <Link href="/dashboard">Back to dashboard</Link>
        <span className="muted">Last event ID: {lastEventId ?? "none"}</span>
      </nav>
      <section className="banner" aria-labelledby="logs-title">
        <span className="pill">{logView.data.deployment.status}</span>
        <h1 id="logs-title">Deployment logs for {deploymentId}</h1>
        <p className="muted">Showing ordered API log metadata for commit {logView.data.deployment.commitSha}.</p>
      </section>
      <section className="card" aria-label="Deployment log events">
        {logView.data.events.length === 0 ? (
          <p className="muted">No log events are available yet.</p>
        ) : (
          <pre className="log">{logView.data.events.map((event) => `${event.sequence} ${event.level.toUpperCase()} ${event.message}`).join("\n")}</pre>
        )}
      </section>
    </main>
  );
}
