import Link from "next/link";
import React from "react";
import { formatBytes } from "../../lib/scaffold-shell";
import { loadRequestAuthSession, loadRequestDashboardMetadata } from "../../lib/server-auth";
import { AppShell } from "@/components/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const auth = await loadRequestAuthSession();

  if (auth.kind !== "authenticated") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>The dashboard needs a valid local API session before metadata can be loaded.</CardDescription>
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

  const metadata = await loadRequestDashboardMetadata();

  if (metadata.kind === "error") {
    return (
      <AppShell email={auth.user.email}>
        <Card>
          <CardHeader>
            <CardTitle>Unable to load platform data</CardTitle>
            <CardDescription>Reason: {metadata.reason}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Alert variant="destructive">
              <AlertTitle>API rejected the dashboard request</AlertTitle>
              <AlertDescription>Retry after the local API is running and the session is valid. Do not start Docker, VPS, Dokploy, Traefik, ACME, DNS, domain, or deployment work for this state.</AlertDescription>
            </Alert>
            <Link href="/dashboard">
              <Button>Retry dashboard</Button>
            </Link>
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const { agents, deployments, projects } = metadata.data;
  const agent = agents[0];
  const resources = agent?.resourceSnapshot;
  const latestDeployment = deployments[0];

  return (
    <AppShell email={auth.user.email}>
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">cookie-session</Badge>
              <CardTitle>Platform status</CardTitle>
            </div>
            <CardDescription>Signed in as {auth.user.email}. Request {metadata.requestId}.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>Authenticated local metadata from the API. This check does not start Docker, VPS, Dokploy, Traefik, ACME, DNS, domain, or deployment work.</p>
            <p>Deployment execution, VPS, Dokploy, Docker socket, Traefik, ACME, DNS, and domain work are intentionally out of scope for this local MVP screen. Real Docker execution is deferred; queued/running/succeeded deploys run through a control-plane simulator.</p>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Projects</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <span className="text-3xl font-semibold tabular-nums">{projects.length}</span>
              <span className="text-sm text-muted-foreground">
                {projects[0] ? `Default branch: ${projects[0].defaultBranch}` : "No projects yet"}
              </span>
              <Link href="/projects">
                <Button size="sm" variant="outline">Manage projects</Button>
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Agents</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <span className="text-3xl font-semibold tabular-nums">{agents.length}</span>
              <span className="text-sm text-muted-foreground">Status: {agent?.status ?? "empty"}</span>
              <span className="text-sm text-muted-foreground">
                {agent ? `Name: ${agent.name}` : "Register an agent to enable real deployment execution"}
              </span>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Resources</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {resources ? (
                <>
                  <span className="text-3xl font-semibold tabular-nums">{Math.round(resources.cpuLoad * 100)}% CPU</span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {formatBytes(resources.memoryUsedBytes)} / {formatBytes(resources.memoryTotalBytes)} memory
                  </span>
                </>
              ) : (
                <>
                  <Skeleton className="h-7 w-24" />
                  <span className="text-sm text-muted-foreground">Waiting for heartbeat</span>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Latest deployment</CardTitle>
            <CardDescription>Last deployment the API has on record.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {latestDeployment ? (
              <Link className="font-mono text-primary underline-offset-4 hover:underline" href={`/deployments/${latestDeployment.id}`}>
                {latestDeployment.id} — {latestDeployment.status}
              </Link>
            ) : (
              <span className="text-muted-foreground">No deployments yet. Create a project to trigger one.</span>
            )}
            <Link href="/deployments">
              <Button size="sm" variant="outline">All deployments</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
