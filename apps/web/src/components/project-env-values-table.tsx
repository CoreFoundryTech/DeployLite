"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  deleteProjectEnvValue,
  writeProjectEnvValue,
  type EnvValueDeleteFailureReason,
  type EnvValueDeleteResult,
  type EnvValueWriteRequest
} from "@/lib/auth-boundary";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EnvSecretValue } from "@deploylite/contracts";

// The raw env secret value is NEVER fetched or rendered. The web layer only
// sees metadata + valueFingerprint. Pasting a new value rotates the encrypted
// record server-side; there is no edit/display path for plaintext.
const envValueCopy = {
  invalidKey: "Use a non-empty key (letters, digits, underscores).",
  invalidValue: "Secret value cannot be empty.",
  saved: "Secret value saved. The encrypted record was updated.",
  unconfigured: "Configure DEPLOYLITE_WEB_API_BASE_URL before saving env values.",
  unreachable: "The local API is unreachable. Start the API and try again.",
  rejected: "The API rejected the env value. Check the key/scope and try again.",
  deleted: "Secret value removed.",
  copyUnavailable: "Clipboard not available in this browser.",
  copyFailed: "Could not copy the fingerprint to the clipboard."
} as const;

type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

type DeleteState =
  | { kind: "idle" }
  | { kind: "deleting"; key: string; scope: "project" | "deployment" }
  | { kind: "deleted"; message: string }
  | { kind: "error"; message: string };

type ProjectEnvValuesTableProps = {
  projectId: string;
  apiBaseUrl: string | null;
  cookieHeader: string;
  envValues: EnvSecretValue[];
};

export type SubmitProjectEnvValueResult =
  | { kind: "saved"; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "unreachable"; message: string }
  | { kind: "unconfigured"; message: string };

export type SubmitProjectEnvValueOptions = {
  projectId: string;
  apiBaseUrl: string | null;
  cookieHeader: string;
  payload: EnvValueWriteRequest;
  fetchImpl?: typeof fetch;
};

/**
 * Pure async handler that mirrors what submitting the create/rotate form does:
 * posts to POST /api/v1/projects/:id/env-values and translates the result into
 * a UI-friendly discriminated union. Extracted so the form click path can be
 * exercised directly from unit tests without a DOM or testing-library setup.
 *
 * The plaintext value is held only for the duration of this call — it is
 * never returned to the caller and never persisted in component state.
 */
export async function submitProjectEnvValue({
  projectId,
  apiBaseUrl,
  cookieHeader,
  payload,
  fetchImpl = fetch
}: SubmitProjectEnvValueOptions): Promise<SubmitProjectEnvValueResult> {
  const result = await writeProjectEnvValue(projectId, payload, { apiBaseUrl: apiBaseUrl ?? undefined, cookieHeader, fetchImpl });
  if (result.kind === "ready") {
    return { kind: "saved", message: envValueCopy.saved };
  }
  if (result.reason === "api-unconfigured") return { kind: "unconfigured", message: envValueCopy.unconfigured };
  if (result.reason === "api-unreachable") return { kind: "unreachable", message: envValueCopy.unreachable };
  return { kind: "rejected", message: envValueCopy.rejected };
}

export type RunProjectEnvValueDeleteResult =
  | { kind: "deleted"; message: string }
  | { kind: "error"; message: string };

export type RunProjectEnvValueDeleteOptions = {
  projectId: string;
  apiBaseUrl: string | null;
  cookieHeader: string;
  key: string;
  scope: "project" | "deployment";
  fetchImpl?: typeof fetch;
};

export function describeEnvValueDeleteFailure(reason: EnvValueDeleteFailureReason): string {
  if (reason === "api-unconfigured") return envValueCopy.unconfigured;
  if (reason === "not-found") return envValueCopy.rejected;
  if (reason === "api-unreachable") return envValueCopy.unreachable;
  if (reason === "invalid-payload") return envValueCopy.rejected;
  return envValueCopy.rejected;
}

export async function runProjectEnvValueDelete({
  projectId,
  apiBaseUrl,
  cookieHeader,
  key,
  scope,
  fetchImpl = fetch
}: RunProjectEnvValueDeleteOptions): Promise<RunProjectEnvValueDeleteResult> {
  const result = await deleteProjectEnvValue(projectId, { key, scope }, { apiBaseUrl: apiBaseUrl ?? undefined, cookieHeader, fetchImpl });
  if (result.kind === "deleted") {
    return { kind: "deleted", message: envValueCopy.deleted };
  }
  return { kind: "error", message: describeEnvValueDeleteFailure(result.reason) };
}

/**
 * Returns a short, masked preview of a valueFingerprint. The fingerprint is
 * already a 32-char hex HMAC digest, but the UI shows only the first 8 + last
 * 4 chars so onlookers cannot read the full digest from shoulder-surfing.
 */
export function maskFingerprint(fingerprint: string | null | undefined): string {
  if (!fingerprint || fingerprint.length < 12) return "••••";
  return `${fingerprint.slice(0, 8)}…${fingerprint.slice(-4)}`;
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function ProjectEnvValuesTable({ projectId, apiBaseUrl, cookieHeader, envValues }: ProjectEnvValuesTableProps) {
  const router = useRouter();
  const [scope, setScope] = useState<"project" | "deployment">("project");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [deleteState, setDeleteState] = useState<DeleteState>({ kind: "idle" });
  const [copyState, setCopyState] = useState<{ key: string | null; message: string | null }>({ key: null, message: null });

  const pending = saveState.kind === "pending";
  const deleting = deleteState.kind === "deleting";

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiBaseUrl) {
      setSaveState({ kind: "error", message: envValueCopy.unconfigured });
      return;
    }
    const form = event.currentTarget as unknown as { key: { value: string }; value: { value: string } };
    const key = form.key.value.trim();
    const value = form.value.value;
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      setSaveState({ kind: "error", message: envValueCopy.invalidKey });
      return;
    }
    if (!value || value.length === 0) {
      setSaveState({ kind: "error", message: envValueCopy.invalidValue });
      return;
    }
    setSaveState({ kind: "pending" });
    const result = await submitProjectEnvValue({
      projectId,
      apiBaseUrl,
      cookieHeader,
      payload: { key, scope, value }
    });
    if (result.kind === "saved") {
      // Wipe the input value from the form before refresh so it doesn't sit
      // in the DOM after navigation. The plaintext is never echoed back.
      event.currentTarget.reset();
      setScope("project");
      setSaveState({ kind: "saved", message: result.message });
      router.refresh();
    } else {
      setSaveState({ kind: "error", message: result.message });
    }
  }

  async function onDelete(key: string, rowScope: "project" | "deployment") {
    if (!apiBaseUrl) {
      setDeleteState({ kind: "error", message: envValueCopy.unconfigured });
      return;
    }
    setDeleteState({ kind: "deleting", key, scope: rowScope });
    const outcome = await runProjectEnvValueDelete({ projectId, apiBaseUrl, cookieHeader, key, scope: rowScope });
    if (outcome.kind === "deleted") {
      setDeleteState({ kind: "deleted", message: outcome.message });
      router.refresh();
    } else {
      setDeleteState({ kind: "error", message: outcome.message });
    }
  }

  async function onCopyFingerprint(fingerprint: string, rowKey: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setCopyState({ key: rowKey, message: envValueCopy.copyUnavailable });
      return;
    }
    try {
      await navigator.clipboard.writeText(fingerprint);
      setCopyState({ key: rowKey, message: null });
    } catch {
      setCopyState({ key: rowKey, message: envValueCopy.copyFailed });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-3" onSubmit={onSave} aria-describedby="env-values-description env-values-status">
        <p id="env-values-description" className="text-sm text-muted-foreground">
          Set or rotate a secret value for an existing env key. Values are encrypted on the server; only the fingerprint, scope, and timestamps are shown below.
        </p>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="env-value-key">Key</FieldLabel>
            <Input
              id="env-value-key"
              name="key"
              required
              placeholder="DATABASE_URL"
              pattern="[A-Za-z0-9_]+"
              disabled={pending}
              autoComplete="off"
              data-testid="env-value-key"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="env-value-scope">Scope</FieldLabel>
            <Select value={scope} onValueChange={(value) => setScope(value as "project" | "deployment")} disabled={pending}>
              <SelectTrigger id="env-value-scope" data-testid="env-value-scope">
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
            <FieldLabel htmlFor="env-value-value">Secret value</FieldLabel>
            <Input
              id="env-value-value"
              name="value"
              type="password"
              required
              placeholder="Paste a new value to set or rotate"
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
              data-testid="env-value-value"
            />
            <FieldDescription>Write-only. The plaintext is sent once to the API and never returned; only the fingerprint is shown below.</FieldDescription>
          </Field>
        </FieldGroup>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending} aria-busy={pending} data-testid="env-value-save">
            {pending ? "Saving..." : "Save secret value"}
          </Button>
          <p
            id="env-values-status"
            className={saveState.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
            role={saveState.kind === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {saveState.kind === "idle"
              ? "Encrypted at rest. Fingerprint shown after save."
              : saveState.kind === "pending"
                ? "Saving secret value…"
                : saveState.message}
          </p>
        </div>
      </form>

      {deleteState.kind === "error" ? (
        <p className="text-sm text-destructive" role="alert" aria-live="polite">{deleteState.message}</p>
      ) : deleteState.kind === "deleted" ? (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">{deleteState.message}</p>
      ) : null}

      {envValues.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground py-6">
            No env secret values yet. Add an env metadata key first, then paste its secret value here to mark it as having a value.
          </CardContent>
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Fingerprint</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {envValues.map((record) => {
              const fingerprint = record.valueFingerprint;
              const isDeleting = deleteState.kind === "deleting" && deleteState.key === record.key && deleteState.scope === record.scope;
              const isCopyingThis = copyState.key === record.key;
              return (
                <TableRow key={`${record.scope}-${record.key}`} data-testid={`env-value-row-${record.key}`}>
                  <TableCell className="font-mono text-xs">{record.key}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{record.scope}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-xs" data-testid={`env-value-fingerprint-${record.key}`}>
                        {maskFingerprint(fingerprint)}
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => fingerprint ? onCopyFingerprint(fingerprint, record.key) : undefined}
                        disabled={!fingerprint}
                        aria-label={`Copy fingerprint for ${record.key}`}
                        data-testid={`env-value-copy-${record.key}`}
                      >
                        {isCopyingThis && copyState.message ? copyState.message : "Copy fingerprint"}
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatTimestamp(record.updatedAt)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatTimestamp(record.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      size="xs"
                      variant="destructive"
                      onClick={() => onDelete(record.key, record.scope)}
                      disabled={isDeleting || pending}
                      aria-busy={isDeleting}
                      data-testid={`env-value-delete-${record.key}`}
                    >
                      {isDeleting ? "Removing..." : "Remove"}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
