import Link from "next/link";
import React from "react";
import { InitialAdminSetupForm, LoginForm } from "./auth-controls";
import { authApiPaths, bootstrapApiPaths, getAuthApiBaseUrl, type BootstrapApiResult } from "../lib/auth-boundary";
import { loadRequestAuthSession, loadRequestBootstrapStatus } from "../lib/server-auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const [auth, bootstrap] = await Promise.all([loadRequestAuthSession(), loadRequestBootstrapStatus()]);
  const apiBaseUrl = getAuthApiBaseUrl();

  if (auth.kind === "authenticated") {
    return (
      <main className="shell stack">
        <section className="banner stack" aria-labelledby="login-title">
          <span className="pill">Cookie session active</span>
          <h1 id="login-title">DeployLite admin shell</h1>
          <p className="muted">Signed in as {auth.user.email} with the canonical {auth.user.role} role.</p>
          <Link className="button" href="/dashboard">Open dashboard</Link>
        </section>
      </main>
    );
  }

  if (bootstrap.kind === "error") {
    return (
      <main className="shell stack">
        <section className="banner stack" aria-labelledby="login-title">
          <span className="pill">Bootstrap status unavailable</span>
          <h1 id="login-title">DeployLite admin shell</h1>
          <p className="alert-message" role="alert">{bootstrapGuidance(bootstrap)}</p>
          <p className="muted">Retry after the local API is reachable and the Web app can call <code>{bootstrapApiPaths.status}</code>. No password or deployment secret is required for this check.</p>
        </section>
      </main>
    );
  }

  if (bootstrap.data.setupRequired) {
    return (
      <main className="shell stack">
        <section className="banner stack" aria-labelledby="login-title">
          <span className="pill">First-run setup required</span>
          <h1 id="login-title">Create the first local admin</h1>
          <p className="muted">No admin account exists yet. Normal sign-in stays unavailable until setup creates the first local admin through <code>{bootstrapApiPaths.initialAdmin}</code>.</p>
          <InitialAdminSetupForm apiBaseUrl={apiBaseUrl} />
        </section>
      </main>
    );
  }

  return (
    <main className="shell stack">
      <section className="banner stack" aria-labelledby="login-title">
        <span className="pill">Setup complete</span>
        <h1 id="login-title">DeployLite admin shell</h1>
        <p className="muted">First-admin setup is complete. Sign in through the API session cookie before viewing protected local metadata. This is an MVP boundary, not a production auth claim.</p>
        <LoginForm apiBaseUrl={apiBaseUrl} reason={auth.reason} />
        <p className="muted">The web shell uses <code>{authApiPaths.me}</code> to validate the HttpOnly session. Reason shown here: {auth.reason}.</p>
      </section>
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
