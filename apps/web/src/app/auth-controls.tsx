"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authApiPaths, createAuthApiRequest, createAuthApiUrl, type AuthBoundaryReason } from "../lib/auth-boundary";

type AuthControlsProps = {
  apiBaseUrl: string | null;
};

function endpoint(path: typeof authApiPaths.login | typeof authApiPaths.logout, apiBaseUrl: string | null): string {
  return apiBaseUrl ? createAuthApiUrl(path, apiBaseUrl) : path;
}

export function LoginForm({ apiBaseUrl, reason }: AuthControlsProps & { reason: AuthBoundaryReason }) {
  const router = useRouter();
  const [message, setMessage] = useState<string>(reason === "api-unconfigured" ? "Configure DEPLOYLITE_WEB_API_BASE_URL when the API runs on another origin." : "");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget as unknown as { email: { value: string }; password: { value: string } };
    const email = form.email.value;
    const password = form.password.value;

    const response = await fetch(
      endpoint(authApiPaths.login, apiBaseUrl),
      createAuthApiRequest({
        method: "POST",
        body: {
          email,
          password
        }
      })
    );

    if (!response.ok) {
      setMessage("Sign in failed. Check the local API credentials and try again.");
      return;
    }

    setMessage("Signed in. Loading dashboard.");
    router.refresh();
    router.push("/dashboard");
  }

  return (
    <form className="stack" aria-label="Admin sign in" data-auth-endpoint={endpoint(authApiPaths.login, apiBaseUrl)} onSubmit={onSubmit}>
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" placeholder="admin@example.test" required />
      </label>
      <label className="field">
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button className="button" type="submit">Sign in with API cookie</button>
      {message ? <p className="muted" role="status">{message}</p> : null}
    </form>
  );
}

export function LogoutButton({ apiBaseUrl }: AuthControlsProps) {
  const router = useRouter();

  async function onLogout() {
    await fetch(endpoint(authApiPaths.logout, apiBaseUrl), createAuthApiRequest({ method: "POST" }));
    router.refresh();
    router.push("/");
  }

  return <button className="link-button" type="button" onClick={onLogout}>Sign out</button>;
}
