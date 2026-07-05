import Link from "next/link";
import React from "react";
import { loadRequestAuthSession, loadRequestDeploymentLogMetadata } from "../../../lib/server-auth";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
  const lastEventId = events.at(-1)?.sequence ?? null;

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

        <Card>
          <CardHeader>
            <CardTitle>Log events</CardTitle>
            <CardDescription>
              {events.length} event(s){lastEventId !== null ? ` · last event ID: ${lastEventId}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No log events are available yet.</p>
            ) : (
              <pre className="overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
                {events.map((event) => `${event.sequence} ${event.level.toUpperCase()} ${event.message}`).join("\n")}
              </pre>
            )}
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
