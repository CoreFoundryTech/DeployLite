"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type Props = { projectId: string; apiBaseUrl: string | null; cookieHeader: string };
type State = "idle" | "saving" | "saved" | "activating" | "unavailable" | "error";

export async function submitRuntimeActivation(projectId: string, apiBaseUrl: string | null, cookieHeader: string, fetchImpl = fetch) {
  if (!apiBaseUrl) return { state: "error" as const, message: "Configure DEPLOYLITE_WEB_API_BASE_URL before requesting activation." };
  try {
    const response = await fetchImpl(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/runtime-activation`, apiBaseUrl), { method: "POST", credentials: "include", headers: { "content-type": "application/json", cookie: cookieHeader }, body: "{}" });
    if (!response.ok) return { state: "error" as const, message: "Runtime activation requires a complete configuration and an admin session." };
    return { state: "unavailable" as const, message: "Activation request recorded. No safe runtime executor is available in this build." };
  } catch { return { state: "error" as const, message: "The local API is unreachable." }; }
}

export function RuntimeConfigurationCard({ projectId, apiBaseUrl, cookieHeader }: Props) {
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState("Runtime values are encrypted at rest and never shown after saving.");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setState("saving");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (!apiBaseUrl) { setState("error"); setMessage("Configure DEPLOYLITE_WEB_API_BASE_URL before saving runtime configuration."); return; }
    try {
      const response = await fetch(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/runtime-configuration`, apiBaseUrl), { method: "PUT", credentials: "include", headers: { "content-type": "application/json", cookie: cookieHeader }, body: JSON.stringify(data) });
      setState(response.ok ? "saved" : "error"); setMessage(response.ok ? "Runtime configuration saved. No activation was started." : "Configuration was rejected. Check all fields and your admin session.");
    } catch { setState("error"); setMessage("The local API is unreachable."); }
  }
  async function activate() { setState("activating"); const result = await submitRuntimeActivation(projectId, apiBaseUrl, cookieHeader); setState(result.state); setMessage(result.message); }
  const pending = state === "saving" || state === "activating";
  return <Card id="runtime-configuration"><CardHeader><CardTitle>Runtime configuration</CardTitle><CardDescription>Only Traefik is public (80/443). API, web, and Postgres remain internal.</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-3" onSubmit={save} aria-describedby="runtime-status"><FieldGroup><Field><FieldLabel htmlFor="runtime-domain">Domain</FieldLabel><Input id="runtime-domain" name="domain" required placeholder="app.example.com" disabled={pending} /></Field><Field><FieldLabel htmlFor="runtime-acme-email">ACME email</FieldLabel><Input id="runtime-acme-email" name="acmeEmail" type="email" required disabled={pending} /></Field><Field><FieldLabel htmlFor="runtime-db-password">Database password</FieldLabel><Input id="runtime-db-password" name="databasePassword" type="password" minLength={16} required autoComplete="new-password" disabled={pending} /></Field><Field><FieldLabel htmlFor="runtime-secret">Runtime secret</FieldLabel><Input id="runtime-secret" name="runtimeSecret" type="password" minLength={16} required autoComplete="new-password" disabled={pending} /></Field></FieldGroup><div className="flex flex-wrap gap-3"><Button type="submit" disabled={pending}>{state === "saving" ? "Saving..." : "Save runtime configuration"}</Button><Button type="button" variant="outline" onClick={activate} disabled={pending}>{state === "activating" ? "Requesting..." : "Request activation"}</Button></div><p id="runtime-status" role={state === "error" ? "alert" : "status"} aria-live="polite" className={state === "error" ? "mt-3 text-sm text-destructive" : "mt-3 text-sm text-muted-foreground"}>{message}</p></form></CardContent></Card>;
}
