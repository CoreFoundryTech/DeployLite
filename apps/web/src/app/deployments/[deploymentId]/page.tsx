import Link from "next/link";
import { createMockPlatformSnapshot, resolveDashboardShell } from "../../../lib/scaffold-shell";
import { loadRequestAuthSession } from "../../../lib/server-auth";

export const dynamic = "force-dynamic";

export default async function DeploymentLogsPage({ params }: { params: Promise<{ deploymentId: string }> }) {
  const { deploymentId } = await params;
  const auth = await loadRequestAuthSession();
  const snapshot = createMockPlatformSnapshot({ session: auth.kind === "authenticated" ? auth.user : null });
  const state = resolveDashboardShell(snapshot);

  if (state.kind !== "ready") {
    return <main className="shell"><section className="banner stack"><h1>{state.title}</h1><p className="muted">{state.description}</p><Link className="button" href="/">Return to sign in</Link></section></main>;
  }

  const { logView } = snapshot;

  return (
    <main className="shell stack">
      <nav className="topbar" aria-label="Deployment navigation">
        <Link href="/dashboard">Back to dashboard</Link>
        <span className="muted">Last event ID: {logView.lastEventId ?? "none"}</span>
      </nav>
      <section className="banner" aria-labelledby="logs-title">
        <span className="pill">{logView.streamState}</span>
        <h1 id="logs-title">Deployment logs for {deploymentId}</h1>
        <p className="muted">The viewer is designed for SSE resume with Last-Event-ID and redacted log payloads.</p>
      </section>
      <section className="card" aria-label="Deployment log events">
        {logView.events.length === 0 ? (
          <p className="muted">No log events are available yet.</p>
        ) : (
          <pre className="log">{logView.events.map((event) => `${event.sequence} ${event.level.toUpperCase()} ${event.message}`).join("\n")}</pre>
        )}
      </section>
    </main>
  );
}
