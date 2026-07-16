import Link from "next/link";
import React from "react";
import { loadRequestAuthSession, loadRequestDeploymentLogMetadata } from "../../../lib/server-auth";
import { AppShell } from "@/components/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { DeploymentLifecycle } from "@/components/deployment-lifecycle";
import { getAuthApiBaseUrl } from "../../../lib/auth-boundary";

export const dynamic = "force-dynamic";

export default async function DeploymentLogsPage({ params }: { params: Promise<{ deploymentId: string }> }) {
  const { deploymentId } = await params;
  const auth = await loadRequestAuthSession();

  if (auth.kind !== "authenticated") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>Deployment logs need a valid API session before metadata can be loaded.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/">
              <Button>Return to sign in</Button>
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  const logView = await loadRequestDeploymentLogMetadata(deploymentId);

  if (logView.kind === "error") {
    return (
      <AppShell email={auth.user.email}>
        <Card>
          <CardHeader>
            <CardTitle>Unable to load deployment logs</CardTitle>
            <CardDescription>Reason: {logView.reason}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/deployments">
              <Button>Back to deployments</Button>
            </Link>
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  if (!logView.data.deployment) {
    return (
      <AppShell email={auth.user.email}>
        <Card>
          <CardHeader>
            <CardTitle>Deployment not found</CardTitle>
            <CardDescription>No deployment metadata exists for {deploymentId}.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/deployments">
              <Button>Back to deployments</Button>
            </Link>
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const deployment = logView.data.deployment;
  const events = logView.data.events;
  const lastEvent = events.at(-1) ?? null;
  const lastEventId = lastEvent?.sequence ?? null;
  const needsAttention = deployment.status === "failed" || deployment.status === "canceled";

  return (
    <AppShell email={auth.user.email}>
      <div className="flex flex-col gap-6">
        <div>
          <Link href="/deployments" className="text-sm text-muted-foreground hover:text-foreground">← Back to deployments</Link>
          <div className="mt-2 flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Deployment {deployment.id}</h1>
            <Badge variant={statusVariant(deployment.status)}>{deployment.status}</Badge>
          </div>
          <p className="font-mono text-sm text-muted-foreground">commit {deployment.commitSha}</p>
        </div>

        <Card data-testid="deployment-evidence-summary">
          <CardHeader>
            <CardTitle>Deployment evidence</CardTitle>
            <CardDescription>Snapshot of the metadata captured for this deployment so the operator can audit what ran.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <EvidenceField label="Status">
                <Badge variant={statusVariant(deployment.status)}>{deployment.status}</Badge>
              </EvidenceField>
              <EvidenceField label="Project">
                <Link
                  href={`/projects/${deployment.projectId}`}
                  className="font-mono text-xs hover:underline"
                  data-testid="evidence-project-link"
                >
                  {deployment.projectId}
                </Link>
              </EvidenceField>
              <EvidenceField label="Commit">
                <span className="font-mono text-xs" data-testid="evidence-commit">{deployment.commitSha}</span>
              </EvidenceField>
              <EvidenceField label="Started">
                <span className="text-xs" data-testid="evidence-started">{new Date(deployment.startedAt).toLocaleString()}</span>
              </EvidenceField>
              <EvidenceField label="Finished">
                <span className="text-xs" data-testid="evidence-finished">
                  {deployment.finishedAt ? new Date(deployment.finishedAt).toLocaleString() : "—"}
                </span>
              </EvidenceField>
              <EvidenceField label="Log events">
                <span className="text-xs" data-testid="evidence-event-count">{events.length}</span>
              </EvidenceField>
              <EvidenceField label="Latest sequence" testId="evidence-latest-sequence">
                <span className="text-xs">
                  {lastEvent ? (
                    <>
                      #{lastEvent.sequence}
                      <span className="text-muted-foreground">
                        {" · "}
                        {lastEvent.redactionApplied ? "redacted" : "raw"}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
              </EvidenceField>
            </div>

            {needsAttention ? (
              <Alert variant="destructive" data-testid="deployment-attention-alert">
                <AlertTitle>This deployment needs attention</AlertTitle>
                <AlertDescription>
                  Open{" "}
                  <Link
                    href={`/projects/${deployment.projectId}#env-metadata`}
                    className="font-medium underline underline-offset-2"
                  >
                    project configuration
                  </Link>{" "}
                  to review env metadata, build/run commands, and the launch checklist before retrying. Avoid
                  suggesting VPS, Docker, Dokploy, Traefik, ACME, or DNS work — DeployLite wires the agent to
                  the project record.
                </AlertDescription>
              </Alert>
            ) : null}

            <Separator />

            <div className="flex flex-wrap gap-2" data-testid="deployment-next-actions">
              <Link href={`/projects/${deployment.projectId}`}>
                <Button variant="default" data-testid="cta-back-to-project">Back to project</Button>
              </Link>
              <Link href="/deployments">
                <Button variant="outline" data-testid="cta-view-all-deployments">View all deployments</Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Log events</CardTitle>
            <CardDescription>{events.length} event(s){lastEventId !== null ? ` · last event ID: ${lastEventId}` : ""}</CardDescription>
          </CardHeader>
          <CardContent>
            <DeploymentLifecycle deployment={deployment} initialLogs={events} apiBaseUrl={getAuthApiBaseUrl()} />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "succeeded") return "secondary";
  if (status === "failed" || status === "canceled") return "destructive";
  if (status === "running" || status === "queued") return "default";
  return "outline";
}

function EvidenceField({
  label,
  children,
  testId
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-3" data-testid={testId}>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}
