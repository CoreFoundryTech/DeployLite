import Link from "next/link";
import { loadRequestAuthSession, loadRequestDashboardMetadata } from "@/lib/server-auth";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function DeploymentsPage() {
  const auth = await loadRequestAuthSession();
  if (auth.kind !== "authenticated") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>Sign in to view deployments.</CardDescription>
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

  const result = await loadRequestDashboardMetadata();
  if (result.kind === "error") {
    return (
      <AppShell email={auth.user.email}>
        <Card>
          <CardHeader>
            <CardTitle>Unable to load deployments</CardTitle>
            <CardDescription>Reason: {result.reason}</CardDescription>
          </CardHeader>
        </Card>
      </AppShell>
    );
  }

  const deployments = result.data.deployments;

  return (
    <AppShell email={auth.user.email}>
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Deployments</h1>
          <p className="text-sm text-muted-foreground">All deployment records on this control plane.</p>
        </div>
        {deployments.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No deployments yet</CardTitle>
              <CardDescription>Trigger a deployment from any project to see it here.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/projects">
                <Button>Open projects</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>All deployments</CardTitle>
              <CardDescription>{deployments.length} record(s)</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Finished</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deployments.map((deployment) => (
                    <TableRow key={deployment.id}>
                      <TableCell className="font-mono text-xs">{deployment.id}</TableCell>
                      <TableCell className="font-mono text-xs">{deployment.projectId}</TableCell>
                      <TableCell><Badge variant={statusVariant(deployment.status)}>{deployment.status}</Badge></TableCell>
                      <TableCell className="font-mono text-xs">{deployment.commitSha}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(deployment.startedAt).toLocaleString()}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{deployment.finishedAt ? new Date(deployment.finishedAt).toLocaleString() : "—"}</TableCell>
                      <TableCell>
                        <Link href={`/deployments/${deployment.id}`}>
                          <Button size="sm" variant="outline">Logs</Button>
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

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "succeeded") return "secondary";
  if (status === "failed" || status === "canceled") return "destructive";
  if (status === "running" || status === "queued") return "default";
  return "outline";
}
