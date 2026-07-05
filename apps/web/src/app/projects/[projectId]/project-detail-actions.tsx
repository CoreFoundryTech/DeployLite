"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { EnvVariableMetadata, Project } from "@deploylite/contracts";

type ProjectDetailActionsProps = {
  project: Project;
  apiBaseUrl: string | null;
  cookieHeader: string;
  envVariables: EnvVariableMetadata[];
};

type TriggerState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "triggered"; deploymentId: string; status: string }
  | { kind: "error"; message: string };

type EnvState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string };

const triggerCopy = {
  invalid: "Could not trigger the deploy. Check that the project has at least one online agent.",
  invalidPayload: "Deploy trigger returned an unexpected response. Try again, and check the API logs if it keeps failing.",
  unconfigured: "Configure DEPLOYLITE_WEB_API_BASE_URL before triggering deploys.",
  unreachable: "The local API is unreachable. Start the API and try again."
} as const;

const envCopy = {
  saved: "Env metadata saved.",
  invalid: "Use a non-empty key (letters, digits, underscores) without secret values.",
  unreachable: "The local API is unreachable. Start the API and try again."
} as const;

export type SubmitProjectDeploymentResult =
  | { kind: "triggered"; deploymentId: string; status: string }
  | { kind: "rejected"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unreachable"; message: string }
  | { kind: "unconfigured"; message: string };

export type SubmitProjectDeploymentOptions = {
  projectId: string;
  apiBaseUrl: string | null;
  cookieHeader: string;
  fetchImpl?: typeof fetch;
};

export type RunProjectDeployTriggerResult = {
  triggerState:
    | { kind: "triggered"; deploymentId: string; status: string }
    | { kind: "error"; message: string };
  redirectPath: string | null;
};

/**
 * Pure async handler that mirrors what clicking "Deploy latest" does:
 * posts to the trigger endpoint and decides whether the client should
 * router.push to `/deployments/{id}` or surface an error state. Extracted
 * so the click path can be exercised directly from unit tests without a
 * DOM or testing-library setup.
 */
export async function runProjectDeployTrigger({
  projectId,
  apiBaseUrl,
  cookieHeader,
  fetchImpl = fetch
}: SubmitProjectDeploymentOptions): Promise<RunProjectDeployTriggerResult> {
  const result = await submitProjectDeployment({ projectId, apiBaseUrl, cookieHeader, fetchImpl });
  if (result.kind === "triggered") {
    return {
      triggerState: { kind: "triggered", deploymentId: result.deploymentId, status: result.status },
      redirectPath: `/deployments/${result.deploymentId}`
    };
  }
  return {
    triggerState: { kind: "error", message: result.message },
    redirectPath: null
  };
}

export async function submitProjectDeployment({
  projectId,
  apiBaseUrl,
  cookieHeader,
  fetchImpl = fetch
}: SubmitProjectDeploymentOptions): Promise<SubmitProjectDeploymentResult> {
  if (!apiBaseUrl) {
    return { kind: "unconfigured", message: triggerCopy.unconfigured };
  }

  const url = new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/deployments`, apiBaseUrl).toString();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({})
    });
  } catch {
    return { kind: "unreachable", message: triggerCopy.unreachable };
  }

  if (!response.ok) {
    return { kind: "rejected", message: triggerCopy.invalid };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "invalid", message: triggerCopy.invalidPayload };
  }

  const deploymentId = extractDeploymentId(payload);
  if (!deploymentId) {
    return { kind: "invalid", message: triggerCopy.invalidPayload };
  }

  return { kind: "triggered", deploymentId, status: extractDeploymentStatus(payload) ?? "queued" };
}

function extractDeploymentId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as { data?: unknown };
  if (!envelope.data || typeof envelope.data !== "object") return null;
  const data = envelope.data as { deployment?: unknown };
  if (!data.deployment || typeof data.deployment !== "object") return null;
  const deployment = data.deployment as { id?: unknown };
  return typeof deployment.id === "string" && deployment.id.length > 0 ? deployment.id : null;
}

function extractDeploymentStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as { data?: unknown };
  if (!envelope.data || typeof envelope.data !== "object") return null;
  const data = envelope.data as { deployment?: unknown };
  if (!data.deployment || typeof data.deployment !== "object") return null;
  const deployment = data.deployment as { status?: unknown };
  return typeof deployment.status === "string" && deployment.status.length > 0 ? deployment.status : null;
}

export function ProjectDetailActions({ project, apiBaseUrl, cookieHeader, envVariables }: ProjectDetailActionsProps) {
  const router = useRouter();
  const [trigger, setTrigger] = useState<TriggerState>({ kind: "idle" });
  const [envState, setEnvState] = useState<EnvState>({ kind: "idle" });
  const [required, setRequired] = useState(false);
  const [scope, setScope] = useState<"project" | "deployment">("project");
  const [description, setDescription] = useState("");

  async function onTrigger() {
    setTrigger({ kind: "pending" });
    const { triggerState, redirectPath } = await runProjectDeployTrigger({ projectId: project.id, apiBaseUrl, cookieHeader });
    setTrigger(triggerState);
    if (redirectPath) {
      router.push(redirectPath);
    }
  }

  async function onAddEnv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEnvState({ kind: "pending" });
    if (!apiBaseUrl) {
      setEnvState({ kind: "error", message: "Configure DEPLOYLITE_WEB_API_BASE_URL." });
      return;
    }
    const form = event.currentTarget as unknown as { key: { value: string } };
    const key = form.key.value.trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      setEnvState({ kind: "error", message: envCopy.invalid });
      return;
    }
    try {
      const response = await fetch(new URL(`/api/v1/projects/${project.id}/env-variables`, apiBaseUrl).toString(), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", cookie: cookieHeader },
        body: JSON.stringify({ key, scope, required, description: description.trim() || null })
      });
      if (!response.ok) {
        setEnvState({ kind: "error", message: envCopy.invalid });
        return;
      }
      setEnvState({ kind: "idle" });
      setDescription("");
      setRequired(false);
      router.refresh();
    } catch {
      setEnvState({ kind: "error", message: envCopy.unreachable });
    }
  }

  async function onRemoveEnv(key: string, envScope: "project" | "deployment") {
    if (!apiBaseUrl) return;
    try {
      await fetch(new URL(`/api/v1/projects/${project.id}/env-variables?key=${encodeURIComponent(key)}&scope=${envScope}`, apiBaseUrl).toString(), {
        method: "DELETE",
        credentials: "include",
        headers: { cookie: cookieHeader }
      });
      router.refresh();
    } catch {
      /* swallow */
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Anchor targets for the launch-checklist CTAs in the parent page; do not rename without updating those links. */}
      <Card id="deploy-actions">
        <CardHeader>
          <CardTitle>Trigger deployment</CardTitle>
          <CardDescription>
            Creates a queued deployment, then transitions it to running and succeeded via the control-plane runner. Real Docker execution is intentionally deferred.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button
            onClick={onTrigger}
            disabled={trigger.kind === "pending"}
            data-state={trigger.kind}
          >
            {trigger.kind === "pending" ? "Triggering..." : "Deploy latest"}
          </Button>
          {trigger.kind === "triggered" ? (
            <p className="text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="deploy-triggered-status">
              Deployment {trigger.deploymentId} queued. Opening logs…
            </p>
          ) : null}
          {trigger.kind === "error" ? <p className="text-sm text-destructive" role="alert" data-testid="deploy-trigger-error">{trigger.message}</p> : null}
        </CardContent>
      </Card>

      <Card id="env-metadata">
        <CardHeader>
          <CardTitle>Env metadata</CardTitle>
          <CardDescription>
            Manage env variable keys (name, required, scope, description). Secret values are never stored or rendered. <code>required</code> variables without a value cause the deploy to fail fast.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="flex flex-col gap-3" onSubmit={onAddEnv}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="env-key">Key</FieldLabel>
                <Input id="env-key" name="key" required placeholder="DATABASE_URL" pattern="[A-Za-z0-9_]+" disabled={envState.kind === "pending"} />
              </Field>
              <Field>
                <FieldLabel htmlFor="env-scope">Scope</FieldLabel>
                <Select value={scope} onValueChange={(value) => setScope(value as "project" | "deployment")} disabled={envState.kind === "pending"}>
                  <SelectTrigger id="env-scope">
                    <SelectValue placeholder="Select scope" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="project">project</SelectItem>
                    <SelectItem value="deployment">deployment</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>project = shared, deployment = per-deploy override.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="env-description">Description (optional)</FieldLabel>
                <Input id="env-description" name="description" value={description} onChange={(event) => setDescription(event.target.value)} disabled={envState.kind === "pending"} placeholder="Postgres connection string" />
              </Field>
              <Field orientation="horizontal" className="flex items-center justify-between rounded-md border p-3">
                <div className="space-y-0.5">
                  <FieldLabel htmlFor="env-required">Required</FieldLabel>
                  <FieldDescription>Deploy fails fast if no value is present for this key.</FieldDescription>
                </div>
                <Switch id="env-required" checked={required} onCheckedChange={setRequired} disabled={envState.kind === "pending"} />
              </Field>
            </FieldGroup>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={envState.kind === "pending"}>{envState.kind === "pending" ? "Saving..." : "Add env metadata"}</Button>
              {envState.kind === "error" ? <p className="text-sm text-destructive" role="alert">{envState.message}</p> : null}
            </div>
          </form>
          {envVariables.length === 0 ? (
            <p className="text-sm text-muted-foreground">No env metadata yet. Add the first key to start tracking required configuration.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {envVariables.map((record) => (
                <li key={`${record.scope}-${record.key}`} className="flex items-center justify-between rounded-md border p-3 text-sm">
                  <div className="flex flex-col">
                    <span className="font-mono">{record.key}</span>
                    <span className="text-xs text-muted-foreground">scope: {record.scope}{record.required ? " · required" : ""}{record.description ? ` · ${record.description}` : ""}</span>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => onRemoveEnv(record.key, record.scope)}>Remove</Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
