"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { updateProject } from "@/lib/auth-boundary";
import type { Project, ProjectUpdateRequest } from "@deploylite/contracts";
import { normalizeProjectConfigUpdate } from "./project-config-edit";

const configCopy = {
  saved: "Project configuration saved. Saved configuration only; no deployment started.",
  rejected: "Project configuration was rejected. Check the fields and try again.",
  unconfigured: "Configure DEPLOYLITE_WEB_API_BASE_URL before saving project configuration.",
  unreachable: "The local API is unreachable. Start the API and try again.",
  invalidPayload: "Project configuration response was invalid. Try again, and check the API logs if it keeps failing."
} as const;

export type ProjectConfigUpdateResult =
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

export type SubmitProjectConfigUpdateOptions = {
  projectId: string;
  apiBaseUrl: string | null;
  cookieHeader: string;
  payload: ProjectUpdateRequest;
  fetchImpl?: typeof fetch;
};

export async function submitProjectConfigUpdate({
  projectId,
  apiBaseUrl,
  cookieHeader,
  payload,
  fetchImpl = fetch
}: SubmitProjectConfigUpdateOptions): Promise<ProjectConfigUpdateResult> {
  const result = await updateProject(projectId, payload, { apiBaseUrl: apiBaseUrl ?? undefined, cookieHeader, fetchImpl });
  if (result.kind === "ready") {
    return { kind: "saved", message: configCopy.saved };
  }
  if (result.reason === "api-unconfigured") return { kind: "error", message: configCopy.unconfigured };
  if (result.reason === "api-unreachable") return { kind: "error", message: configCopy.unreachable };
  return { kind: "error", message: configCopy.rejected };
}

type ProjectConfigEditFormProps = {
  project: Project;
  apiBaseUrl: string | null;
  cookieHeader: string;
};

type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

export function ProjectConfigEditForm({ project, apiBaseUrl, cookieHeader }: ProjectConfigEditFormProps) {
  const router = useRouter();
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const normalized = normalizeProjectConfigUpdate(project, {
      name: String(formData.get("name") ?? ""),
      repoUrl: String(formData.get("repoUrl") ?? ""),
      defaultBranch: String(formData.get("defaultBranch") ?? ""),
      buildCommand: String(formData.get("buildCommand") ?? ""),
      runCommand: String(formData.get("runCommand") ?? ""),
      port: String(formData.get("port") ?? ""),
      description: String(formData.get("description") ?? "")
    });

    if (!normalized.ok) {
      setSaveState({ kind: "error", message: normalized.message });
      return;
    }

    setSaveState({ kind: "pending" });
    const result = await submitProjectConfigUpdate({
      projectId: project.id,
      apiBaseUrl,
      cookieHeader,
      payload: normalized.payload
    });
    setSaveState(result.kind === "saved" ? { kind: "saved", message: result.message } : { kind: "error", message: result.message });
    if (result.kind === "saved") {
      router.refresh();
    }
  }

  const pending = saveState.kind === "pending";

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit} aria-describedby="project-config-edit-description project-config-edit-status">
      <div>
        <h2 className="text-base font-semibold">Edit project configuration</h2>
        <p id="project-config-edit-description" className="text-sm text-muted-foreground">
          Update source and runtime metadata. Saved configuration only; no deployment started.
        </p>
      </div>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="project-name">Name</FieldLabel>
          <Input id="project-name" name="name" defaultValue={project.name} disabled={pending} required />
        </Field>
        <Field>
          <FieldLabel htmlFor="project-repo-url">Repository URL</FieldLabel>
          <Input id="project-repo-url" name="repoUrl" defaultValue={project.repoUrl} disabled={pending} required type="url" />
        </Field>
        <Field>
          <FieldLabel htmlFor="project-default-branch">Default branch</FieldLabel>
          <Input id="project-default-branch" name="defaultBranch" defaultValue={project.defaultBranch} disabled={pending} required />
        </Field>
        <Field>
          <FieldLabel htmlFor="project-build-command">Build command</FieldLabel>
          <Input id="project-build-command" name="buildCommand" defaultValue={project.buildCommand ?? ""} disabled={pending} placeholder="pnpm build" />
          <FieldDescription>Leave empty to clear the build step.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="project-run-command">Run command</FieldLabel>
          <Input id="project-run-command" name="runCommand" defaultValue={project.runCommand ?? ""} disabled={pending} placeholder="pnpm start" />
          <FieldDescription>Leave empty to mark runtime as not configured.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="project-port">Port</FieldLabel>
          <Input id="project-port" name="port" defaultValue={project.port?.toString() ?? ""} disabled={pending} inputMode="numeric" placeholder="3000" />
          <FieldDescription>Use a whole number from 1 to 65535, or leave empty to clear.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="project-description">Description</FieldLabel>
          <Input id="project-description" name="description" defaultValue={project.description ?? ""} disabled={pending} maxLength={2000} placeholder="Short summary shown next to the project" />
          <FieldDescription>Up to 2000 characters. Leave empty to clear.</FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending} aria-busy={pending}>{pending ? "Saving..." : "Save configuration"}</Button>
        <Button type="reset" variant="outline" disabled={pending} onClick={() => setSaveState({ kind: "idle" })}>Cancel changes</Button>
      </div>
      <p id="project-config-edit-status" className={saveState.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"} role={saveState.kind === "error" ? "alert" : "status"} aria-live="polite">
        {saveState.kind === "idle" ? "Saved configuration only; no deployment started." : saveState.kind === "pending" ? "Saving project configuration…" : saveState.message}
      </p>
    </form>
  );
}
