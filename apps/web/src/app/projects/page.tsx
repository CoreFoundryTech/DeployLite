import Link from "next/link";
import { loadRequestAuthSession, loadRequestDashboardMetadata } from "@/lib/server-auth";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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

  const projects = metadata.data.projects;

  return (
    <AppShell email={auth.user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <p className="text-sm text-muted-foreground">
              Configure a source repo, build command, run command, port, and required env metadata. Trigger deployments from each project.
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
              <CardTitle>All projects</CardTitle>
              <CardDescription>{projects.length} configured</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Repository</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Build</TableHead>
                    <TableHead>Run</TableHead>
                    <TableHead>Port</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((project) => (
                    <TableRow key={project.id}>
                      <TableCell className="font-medium">{project.name}</TableCell>
                      <TableCell className="font-mono text-xs">{project.repoUrl}</TableCell>
                      <TableCell><Badge variant="outline">{project.defaultBranch}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{project.buildCommand ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{project.runCommand ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground tabular-nums">{project.port ?? "—"}</TableCell>
                      <TableCell>
                        <Link href={`/projects/${project.id}`}>
                          <Button size="sm" variant="outline">Open</Button>
                        </Link>
                      </TableCell>
                    </TableRow>
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
