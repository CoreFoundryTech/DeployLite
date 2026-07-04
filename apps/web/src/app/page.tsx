import Link from "next/link";
import { LoginForm } from "./auth-controls";
import { authApiPaths, getAuthApiBaseUrl } from "../lib/auth-boundary";
import { loadRequestAuthSession } from "../lib/server-auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const auth = await loadRequestAuthSession();
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

  return (
    <main className="shell stack">
      <section className="banner stack" aria-labelledby="login-title">
        <span className="pill">Cookie-backed auth boundary</span>
        <h1 id="login-title">DeployLite admin shell</h1>
        <p className="muted">Sign in through the API session cookie before viewing protected mock deployment data. This is an MVP boundary, not a production auth claim.</p>
        <LoginForm apiBaseUrl={apiBaseUrl} reason={auth.reason} />
        <p className="muted">The web shell uses <code>{authApiPaths.me}</code> to validate the HttpOnly session. Reason shown here: {auth.reason}.</p>
      </section>
    </main>
  );
}
