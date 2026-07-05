"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authApiPaths, bootstrapApiPaths, createAuthApiRequest, createAuthApiUrl, createInitialAdminApiRequest, type AuthBoundaryReason } from "../lib/auth-boundary";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type AuthControlsProps = {
  apiBaseUrl: string | null;
};

type InitialAdminSetupState = {
  message: string;
  error: string;
  created: boolean;
  pending: boolean;
};

type InitialAdminSetupSubmitResult =
  | { kind: "success"; message: string }
  | { kind: "locked"; error: string }
  | { kind: "rejected"; error: string }
  | { kind: "unreachable"; error: string };

const initialAdminSetupCopy = {
  idle: "Create the first local admin, then sign in with that account.",
  pending: "Creating the first local admin account.",
  success: "First admin created. Sign in with the new local admin account, then open the dashboard to register a project.",
  locked: "Initial admin setup is locked because an admin already exists. Sign in instead.",
  rejected: "Initial admin setup failed. Use a valid email and a password with at least 12 characters.",
  unreachable: "Initial admin setup could not reach the local API. Check that the API process is running."
} as const;

function endpoint(path: string, apiBaseUrl: string | null): string {
  return apiBaseUrl ? createAuthApiUrl(path, apiBaseUrl) : path;
}

function loginReasonMessage(reason: AuthBoundaryReason): string {
  if (reason === "api-unconfigured") return "Configure DEPLOYLITE_WEB_API_BASE_URL when the API runs on another origin.";
  if (reason === "api-rejected") return "The API rejected the saved session. Sign in again with the local admin account.";
  if (reason === "api-unreachable") return "The local API is unreachable. Start the API and retry sign in.";
  return "Sign in after first-admin setup is complete.";
}

export function LoginForm({ apiBaseUrl, reason }: AuthControlsProps & { reason: AuthBoundaryReason }) {
  const router = useRouter();
  const [message, setMessage] = useState<string>(loginReasonMessage(reason));
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("Checking the local API session.");
    const form = event.currentTarget as unknown as { email: { value: string }; password: { value: string } };
    const email = form.email.value;
    const password = form.password.value;

    try {
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
        setMessage("Sign in failed. Check the local admin credentials and try again.");
        return;
      }

      setMessage("Signed in. Loading dashboard.");
      router.refresh();
      router.push("/dashboard");
    } catch {
      setMessage("Sign in could not reach the local API. Check that the API process is running.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" aria-label="Admin sign in" data-auth-endpoint={endpoint(authApiPaths.login, apiBaseUrl)} onSubmit={onSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input id="email" name="email" type="email" autoComplete="email" placeholder="admin@example.test" required disabled={pending} />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input id="password" name="password" type="password" autoComplete="current-password" required disabled={pending} />
        </Field>
      </FieldGroup>
      <Button type="submit" disabled={pending}>{pending ? "Signing in..." : "Sign in with API cookie"}</Button>
      {message ? <p className="text-sm text-muted-foreground" role="status" aria-live="polite">{message}</p> : null}
    </form>
  );
}

export function InitialAdminSetupForm({ apiBaseUrl }: AuthControlsProps) {
  const router = useRouter();
  const [message, setMessage] = useState<string>(initialAdminSetupCopy.idle);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage(initialAdminSetupCopy.pending);

    const form = event.currentTarget as unknown as { email: { value: string }; password: { value: string } };

    const result = await submitInitialAdminSetup({
      apiBaseUrl,
      email: form.email.value,
      password: form.password.value
    });

    try {
      if (result.kind !== "success") {
        setError(result.error);
        return;
      }

      setCreated(true);
      setMessage(result.message);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return <InitialAdminSetupPanel apiBaseUrl={apiBaseUrl} state={{ message, error, created, pending }} onSubmit={onSubmit} />;
}

export async function submitInitialAdminSetup({
  apiBaseUrl,
  email,
  password,
  fetchImpl = fetch
}: AuthControlsProps & { email: string; password: string; fetchImpl?: typeof fetch }): Promise<InitialAdminSetupSubmitResult> {
  try {
    const response = await fetchImpl(
      endpoint(bootstrapApiPaths.initialAdmin, apiBaseUrl),
      createInitialAdminApiRequest({ email, password })
    );

    if (response.status === 409) return { kind: "locked", error: initialAdminSetupCopy.locked };
    if (!response.ok) return { kind: "rejected", error: initialAdminSetupCopy.rejected };

    return { kind: "success", message: initialAdminSetupCopy.success };
  } catch {
    return { kind: "unreachable", error: initialAdminSetupCopy.unreachable };
  }
}

export function InitialAdminSetupPanel({ apiBaseUrl, state, onSubmit }: AuthControlsProps & { state: InitialAdminSetupState; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const { message, error, created, pending } = state;

  return (
    <div className="flex flex-col gap-4" aria-label="First admin setup panel">
      <form className="flex flex-col gap-4" aria-label="Create first admin" data-bootstrap-endpoint={endpoint(bootstrapApiPaths.initialAdmin, apiBaseUrl)} onSubmit={onSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="admin-email">Admin email</FieldLabel>
            <Input id="admin-email" name="email" type="email" autoComplete="email" placeholder="admin@example.test" required disabled={pending || created} />
            <FieldDescription>Use a real local-only email; it never leaves the DeployLite database.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="admin-password">Admin password</FieldLabel>
            <Input id="admin-password" name="password" type="password" autoComplete="new-password" minLength={12} required disabled={pending || created} />
            <FieldDescription>At least 12 characters.</FieldDescription>
          </Field>
        </FieldGroup>
        <Button type="submit" disabled={pending || created}>{pending ? "Creating admin..." : "Create first admin"}</Button>
      </form>
      <p className="text-sm text-muted-foreground" role="status" aria-live="polite">{message}</p>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      {created ? (
        <div className="flex flex-col gap-3" data-testid="first-owner-success-summary">
          <p className="text-sm text-muted-foreground">
            After sign-in, continue into the dashboard to register your first project and trigger a deployment.
          </p>
          <Link href="/dashboard" data-testid="first-owner-continue-cta" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Open the dashboard →
          </Link>
          <LoginForm apiBaseUrl={apiBaseUrl} reason="missing-cookie" />
        </div>
      ) : null}
    </div>
  );
}

export function LogoutButton({ apiBaseUrl }: AuthControlsProps) {
  const router = useRouter();

  async function onLogout() {
    await fetch(endpoint(authApiPaths.logout, apiBaseUrl), createAuthApiRequest({ method: "POST" }));
    router.refresh();
    router.push("/");
  }

  return (
    <Button type="button" variant="ghost" size="sm" onClick={onLogout}>Sign out</Button>
  );
}
