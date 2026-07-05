import Link from "next/link";
import { loadRequestAuthSession, loadRequestDashboardMetadata } from "@/lib/server-auth";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { summarizeProjectLaunch, type ProjectLaunchSummary } from "./project-launch-hub";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const auth = await loadRequestAuthSession();
  if (auth.kind !== "authenticated") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>Sign in to manage projects.</CardDescription>
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
            <CardTitle>Unable to load projects</CardTitle>
            <CardDescription>Reason: {metadata.reason}</CardDescription>
          </CardHeader>
        </Card>
      </AppShell>
    );
  }

  const { projects, deployments } = metadata.data;
  const launchHubRows = projects.map((project) => summarizeProjectLaunch(project, deployments));
  const readyCount = launchHubRows.filter((row) => row.nextAction.ctaKey === "inspect-latest-logs").length;

  return (
    <AppShell email={auth.user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
              <Badge variant="secondary" data-testid="projects-launch-hub-badge">Launch hub</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Review each project&apos;s runtime readiness, latest deployment status, and jump to the next action to keep launches moving.
            </p>
          </div>
          <Link href="/projects/new">
            <Button>New project</Button>
          </Link>
        </div>

        {projects.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No projects yet</CardTitle>
              <CardDescription>Create your first project to start the deploy flow.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/projects/new">
                <Button>Create project</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>All projects</CardTitle>
                  <CardDescription>
                    {projects.length} configured · {readyCount} with a latest deployment to inspect
                  </CardDescription>
                </div>
                <Badge variant="outline" data-testid="projects-launch-hub-summary">
                  {readyCount}/{projects.length} launchable
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <Table data-testid="projects-launch-hub-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Repository</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Runtime</TableHead>
                    <TableHead>Latest</TableHead>
                    <TableHead>Next step</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {launchHubRows.map((row) => (
                    <LaunchHubRow key={row.project.id} row={row} />
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

function LaunchHubRow({ row }: { row: ProjectLaunchSummary }) {
  return (
    <TableRow data-testid="project-launch-row" data-project-id={row.project.id}>
      <TableCell className="font-medium">
        <Link href={`/projects/${row.project.id}`} className="hover:underline">
          {row.project.name}
        </Link>
      </TableCell>
      <TableCell className="font-mono text-xs">{row.project.repoUrl}</TableCell>
      <TableCell><Badge variant="outline">{row.project.defaultBranch}</Badge></TableCell>
      <TableCell data-testid="project-launch-runtime">
        <div className="flex flex-col gap-1">
          <Badge variant={row.runtime.configured ? "secondary" : "destructive"} data-testid="project-launch-runtime-badge">
            {row.runtime.label}
          </Badge>
          <span className="text-xs text-muted-foreground">{row.runtime.detail}</span>
        </div>
      </TableCell>
      <TableCell data-testid="project-launch-latest">
        <div className="flex flex-col gap-1">
          <Badge variant={latestStatusVariant(row.latest.statusTone)} data-testid="project-launch-latest-badge">
            {row.latest.statusLabel}
          </Badge>
          {row.latest.deployment ? (
            <span className="font-mono text-xs text-muted-foreground" data-testid="project-launch-latest-id">
              {row.latest.deployment.id}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">No deployments yet</span>
          )}
        </div>
      </TableCell>
      <TableCell data-testid="project-launch-next-action" className="text-sm">
        {row.nextAction.label}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex flex-wrap justify-end gap-2" data-testid="project-launch-actions">
          <Link href={row.configureHref}>
            <Button size="sm" variant="outline" data-testid="project-launch-cta-configure" aria-label={`Configure runtime for ${row.project.name}`}>
              Configure
            </Button>
          </Link>
          <Link href={row.deployHref}>
            <Button size="sm" variant="outline" data-testid="project-launch-cta-deploy" aria-label={`Open deploy panel for ${row.project.name}`}>
              Deploy
            </Button>
          </Link>
          {row.logsHref ? (
            <Link href={row.logsHref}>
              <Button size="sm" data-testid="project-launch-cta-logs" aria-label={`Open latest deployment logs for ${row.project.name}`}>
                Logs
              </Button>
            </Link>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function latestStatusVariant(tone: ProjectLaunchSummary["latest"]["statusTone"]): "default" | "secondary" | "destructive" | "outline" {
  if (tone === "ready") return "secondary";
  if (tone === "attention") return "destructive";
  if (tone === "active") return "default";
  return "outline";
}
