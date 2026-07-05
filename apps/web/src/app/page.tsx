import Link from "next/link";
import React from "react";
import { InitialAdminSetupForm, LoginForm } from "./auth-controls";
import { authApiPaths, bootstrapApiPaths, getAuthApiBaseUrl, type BootstrapApiResult } from "../lib/auth-boundary";
import { loadRequestAuthSession, loadRequestBootstrapStatus } from "../lib/server-auth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const [auth, bootstrap] = await Promise.all([loadRequestAuthSession(), loadRequestBootstrapStatus()]);
  const apiBaseUrl = getAuthApiBaseUrl();

  if (auth.kind === "authenticated") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>DeployLite admin shell</CardTitle>
            <CardDescription>Signed in as {auth.user.email} with the canonical {auth.user.role} role.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/dashboard">
              <Button>Open dashboard</Button>
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (bootstrap.kind === "error") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>DeployLite admin shell</CardTitle>
            <CardDescription>Bootstrap status unavailable.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Alert variant="destructive">
              <AlertTitle>Local API unreachable</AlertTitle>
              <AlertDescription>{bootstrapGuidance(bootstrap)}</AlertDescription>
            </Alert>
            <p className="text-sm text-muted-foreground">
              Retry after the local API is reachable and the Web app can call <code>{bootstrapApiPaths.status}</code>. No password or deployment secret is required for this check.
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (bootstrap.data.setupRequired) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Create the first local admin</CardTitle>
            <CardDescription>
              No admin account exists yet. Normal sign-in stays unavailable until setup creates the first local admin through <code>{bootstrapApiPaths.initialAdmin}</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <InitialAdminSetupForm apiBaseUrl={apiBaseUrl} />
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>DeployLite admin shell</CardTitle>
          <CardDescription>
            First-admin setup is complete. Sign in through the API session cookie before viewing protected local metadata. This is an MVP boundary, not a production auth claim.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <LoginForm apiBaseUrl={apiBaseUrl} reason={auth.reason} />
          <p className="text-sm text-muted-foreground">
            The web shell uses <code>{authApiPaths.me}</code> to validate the HttpOnly session. Reason shown here: {auth.reason}.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

function bootstrapGuidance(bootstrap: Extract<BootstrapApiResult, { kind: "error" }>): string {
  if (bootstrap.reason === "api-unconfigured") return "Configure DEPLOYLITE_WEB_API_BASE_URL so the Web app can reach the local API before setup.";
  if (bootstrap.reason === "api-unreachable") return "The Web app could not reach the local API. Start the API and retry this page.";
  if (bootstrap.reason === "invalid-payload") return "The local API returned an unexpected bootstrap status payload. Check that Web and API packages are built from the same revision.";
  if (bootstrap.status === 409) return "Initial admin setup is locked because an admin already exists. Sign in with that account instead.";
  return `The local API rejected bootstrap status with status ${bootstrap.status ?? "unknown"}. Check the local API logs and retry.`;
}
