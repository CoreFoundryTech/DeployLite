import Link from "next/link";
import { cookies } from "next/headers";
import { getAuthApiBaseUrl } from "@/lib/auth-boundary";
import { loadRequestAuthSession, loadRequestProjectDetailMetadata } from "@/lib/server-auth";
import { ProjectDetailActions } from "./project-detail-actions";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

type Params = { projectId: string };

export default async function ProjectDetailPage({ params }: { params: Promise<Params> }) {
  const { projectId } = await params;
  const auth = await loadRequestAuthSession();
  if (auth.kind !== "authenticated") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>Sign in to view project details.</CardDescription>
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

  const result = await loadRequestProjectDetailMetadata(projectId);
  if (result.kind === "error") {
    if (result.status === 404) {
      return (
        <AppShell email={auth.user.email}>
          <Card>
            <CardHeader>
              <CardTitle>Project not found</CardTitle>
              <CardDescription>No project with id {projectId}.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/projects">
                <Button>Back to projects</Button>
              </Link>
            </CardContent>
          </Card>
        </AppShell>
      );
    }
    return (
      <AppShell email={auth.user.email}>
        <Card>
          <CardHeader>
            <CardTitle>Unable to load project</CardTitle>
            <CardDescription>Reason: {result.reason}</CardDescription>
          </CardHeader>
        </Card>
      </AppShell>
    );
  }

  const { project, envVariables, deployments } = result.data;
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  return (
    <AppShell email={auth.user.email}>
      <div className="flex flex-col gap-6">
        <div>
          <Link href="/projects" className="text-sm text-muted-foreground hover:text-foreground">← Back to projects</Link>
          <div className="mt-2 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
              <p className="font-mono text-sm text-muted-foreground">{project.repoUrl}</p>
            </div>
            <Badge variant="outline">{project.defaultBranch}</Badge>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Project configuration</CardTitle>
            <CardDescription>Stored as durable metadata on the project record.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <ConfigRow label="Build command" value={project.buildCommand ?? "—"} />
            <ConfigRow label="Run command" value={project.runCommand ?? "—"} />
            <ConfigRow label="Port" value={project.port?.toString() ?? "—"} />
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Recent deployments</CardTitle>
                <CardDescription>{deployments.length} deployment(s) for this project.</CardDescription>
              </CardHeader>
              <CardContent>
                {deployments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No deployments yet. Trigger the first one from the right panel.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>ID</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Commit</TableHead>
                        <TableHead>Started</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {deployments.map((deployment) => (
                        <TableRow key={deployment.id}>
                          <TableCell className="font-mono text-xs">{deployment.id}</TableCell>
                          <TableCell><Badge variant={statusVariant(deployment.status)}>{deployment.status}</Badge></TableCell>
                          <TableCell className="font-mono text-xs">{deployment.commitSha}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{new Date(deployment.startedAt).toLocaleString()}</TableCell>
                          <TableCell>
                            <Link href={`/deployments/${deployment.id}`}>
                              <Button size="sm" variant="outline">View</Button>
                            </Link>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
          <div>
            <ProjectDetailActions
              project={project}
              apiBaseUrl={getAuthApiBaseUrl()}
              cookieHeader={cookieHeader}
              envVariables={envVariables}
            />
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  );
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "succeeded") return "secondary";
  if (status === "failed" || status === "canceled") return "destructive";
  if (status === "running" || status === "queued") return "default";
  return "outline";
}

void Separator;
