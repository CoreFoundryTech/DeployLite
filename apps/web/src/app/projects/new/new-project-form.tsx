"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ProjectCreateRequest } from "@deploylite/contracts";

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string };

const newProjectCopy = {
  success: "Project created. Loading project detail.",
  invalidInput: "Check that name, repo URL, default branch, and (optional) port/build/run are valid.",
  unreachable: "The local API is unreachable. Start the API and try again."
} as const;

export function NewProjectForm({ apiBaseUrl, cookieHeader }: { apiBaseUrl: string | null; cookieHeader: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus({ kind: "pending" });
    const form = event.currentTarget as unknown as {
      name: { value: string };
      repoUrl: { value: string };
      defaultBranch: { value: string };
      buildCommand: { value: string };
      runCommand: { value: string };
      port: { value: string };
    };
    const input: ProjectCreateRequest = {
      name: form.name.value.trim(),
      repoUrl: form.repoUrl.value.trim(),
      defaultBranch: form.defaultBranch.value.trim() || "main"
    };
    const build = form.buildCommand.value.trim();
    const run = form.runCommand.value.trim();
    const portRaw = form.port.value.trim();
    if (build) input.buildCommand = build;
    if (run) input.runCommand = run;
    if (portRaw) input.port = Number(portRaw);

    if (!apiBaseUrl) {
      setStatus({ kind: "error", message: "Configure DEPLOYLITE_WEB_API_BASE_URL before creating projects." });
      return;
    }

    try {
      const response = await fetch(new URL("/api/v1/projects", apiBaseUrl).toString(), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", cookie: cookieHeader },
        body: JSON.stringify(input)
      });
      if (!response.ok) {
        setStatus({ kind: "error", message: newProjectCopy.invalidInput });
        return;
      }
      const payload = (await response.json()) as { data: { project: { id: string } } | null };
      if (!payload.data?.project) {
        setStatus({ kind: "error", message: newProjectCopy.invalidInput });
        return;
      }
      setStatus({ kind: "pending" });
      router.push(`/projects/${payload.data.project.id}`);
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: newProjectCopy.unreachable });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New project</CardTitle>
        <CardDescription>Source repository, build, run, and port are required to trigger a real deploy run.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">Name</FieldLabel>
              <Input id="project-name" name="name" required placeholder="My API" disabled={status.kind === "pending"} />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-repo">Source repository</FieldLabel>
              <Input id="project-repo" name="repoUrl" type="url" required placeholder="https://github.com/example/my-api" disabled={status.kind === "pending"} />
              <FieldDescription>Repository URL is metadata only; this local MVP does not clone the repo.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="project-branch">Default branch</FieldLabel>
              <Input id="project-branch" name="defaultBranch" defaultValue="main" required disabled={status.kind === "pending"} />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-build">Build command (optional)</FieldLabel>
              <Input id="project-build" name="buildCommand" placeholder="pnpm install && pnpm build" disabled={status.kind === "pending"} />
              <FieldDescription>Shown verbatim in deployment log metadata.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="project-run">Run command (optional)</FieldLabel>
              <Input id="project-run" name="runCommand" placeholder="node dist/server.js" disabled={status.kind === "pending"} />
              <FieldDescription>When empty, the deploy stays in queued state.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="project-port">Port (optional)</FieldLabel>
              <Input id="project-port" name="port" type="number" min={1} max={65535} placeholder="3000" disabled={status.kind === "pending"} />
              <FieldDescription>1 to 65535. No socket or proxy is wired in this local MVP.</FieldDescription>
            </Field>
          </FieldGroup>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={status.kind === "pending"}>{status.kind === "pending" ? "Creating..." : "Create project"}</Button>
            {status.kind === "error" ? <p className="text-sm text-destructive" role="alert">{status.message}</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
