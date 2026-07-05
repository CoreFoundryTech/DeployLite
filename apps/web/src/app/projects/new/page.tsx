import Link from "next/link";
import { loadRequestAuthSession } from "@/lib/server-auth";
import { getAuthApiBaseUrl } from "@/lib/auth-boundary";
import { NewProjectForm } from "./new-project-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  const auth = await loadRequestAuthSession();
  if (auth.kind !== "authenticated") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>Sign in before creating projects.</CardDescription>
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

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="flex flex-col gap-6">
        <div>
          <Link href="/projects" className="text-sm text-muted-foreground hover:text-foreground">← Back to projects</Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Create a project</h1>
          <p className="text-sm text-muted-foreground">
            After creation, configure env metadata keys (never values) and trigger a deploy.
          </p>
        </div>
        <NewProjectForm apiBaseUrl={getAuthApiBaseUrl()} cookieHeader="" />
      </div>
    </main>
  );
}
