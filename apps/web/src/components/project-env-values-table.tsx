"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  deleteProjectEnvValue,
  writeProjectEnvValue,
  type EnvValueDeleteResult,
  type EnvValueWriteRequest
} from "@/lib/auth-boundary";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EnvSecretValue } from "@deploylite/contracts";

// The raw env secret value is NEVER fetched or rendered. The web layer only
// sees metadata + valueFingerprint. Pasting a new value rotates the encrypted
// record server-side; there is no edit/display path for plaintext.
const envValueCopy = {
  invalidKey: "Use a non-empty key (up to 128 characters).",
  invalidValue: "Secret value cannot be empty.",
  saved: "Secret value saved. The encrypted record was updated.",
  unconfigured: "Configure DEPLOYLITE_WEB_API_BASE_URL before saving env values.",
  unreachable: "The local API is unreachable. Start the API and try again.",
  rejected: "The API rejected the env value. Check the key/scope and try again.",
  deleted: "Secret value removed.",
  copyUnavailable: "Clipboard not available in this browser.",
  copyFailed: "Could not copy the fingerprint to the clipboard."
} as const;

// Delete-path copy is split by failure class (B5) so a 404 (already removed),
// a 403 (forbidden), a 5xx (server error), and a malformed response each give a
// distinct, actionable message instead of collapsing into one generic string.
const envValueDeleteCopy = {
  unconfigured: "Configure DEPLOYLITE_WEB_API_BASE_URL before removing env values.",
  forbidden: "You do not have permission to remove this env value.",
  notFound: "This env value is already gone. Reload the list.",
  rejected: "The env value could not be removed. Refresh and try again.",
  invalid: "Remove response was invalid. Refresh and try again.",
  unreachable: "The local API is unreachable. Start the API and try again."
} as const;

type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

type DeleteState =
  | { kind: "idle" }
  | { kind: "deleting"; key: string; scope: "project" | "deployment" }
  | { kind: "deleted"; key: string; scope: "project" | "deployment"; message: string }
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

export function describeEnvValueDeleteFailure(result: Extract<EnvValueDeleteResult, { kind: "error" }>): string {
  if (result.reason === "api-unconfigured") return envValueDeleteCopy.unconfigured;
  if (result.reason === "not-found") return envValueDeleteCopy.notFound;
  if (result.reason === "api-rejected") {
    return result.status === 403 ? envValueDeleteCopy.forbidden : envValueDeleteCopy.rejected;
  }
  if (result.reason === "invalid-payload") return envValueDeleteCopy.invalid;
  return envValueDeleteCopy.unreachable;
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
  return { kind: "error", message: describeEnvValueDeleteFailure(result) };
}

/**
 * Returns a short, masked preview of a valueFingerprint. The fingerprint is
 * already a 32-char hex HMAC digest, but the UI shows only the first 8 + last 4
 * chars so onlookers cannot read the full digest from shoulder-surfing.
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

// A row is uniquely identified by scope + key: the same key can legitimately
// exist under both the "project" and "deployment" scopes, so every per-row
// piece of state (copy feedback, testid, dialog open) is keyed by the pair to
// avoid collisions (B8).
function rowId(scope: "project" | "deployment", key: string): string {
  return `${scope}-${key}`;
}

export function ProjectEnvValuesTable({ projectId, apiBaseUrl, cookieHeader, envValues }: ProjectEnvValuesTableProps) {
  const router = useRouter();
  const [scope, setScope] = useState<"project" | "deployment">("project");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [deleteState, setDeleteState] = useState<DeleteState>({ kind: "idle" });
  // Tracks which row's confirmation dialog is open (B3). Only one dialog is
  // open at a time; null means all closed.
  const [confirmDelete, setConfirmDelete] = useState<{ key: string; scope: "project" | "deployment" } | null>(null);
  // Per-row copy feedback keyed by `${scope}-${key}` (B8).
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
    // Align UI validation with the server contract (B6): the contract only
    // requires a non-empty string up to 128 chars. The old [A-Za-z0-9_]+ regex
    // blocked legitimate keys with "-", ".", and "/". Do not re-impose a
    // stricter charset than the API enforces.
    if (!key || key.length > 128) {
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

  async function onConfirmDelete(key: string, rowScope: "project" | "deployment") {
    if (!apiBaseUrl) {
      setDeleteState({ kind: "error", message: envValueDeleteCopy.unconfigured });
      return;
    }
    setDeleteState({ kind: "deleting", key, scope: rowScope });
    const outcome = await runProjectEnvValueDelete({ projectId, apiBaseUrl, cookieHeader, key, scope: rowScope });
    if (outcome.kind === "deleted") {
      // Keep the row locked (B4): stay in the "deleted" state for this key+scope
      // so the trigger remains disabled until router.refresh() repaints the
      // list and the row vanishes. Closing the dialog here is safe because the
      // lock is held by deleteState, not by dialog open state — a second click
      // on the trigger is blocked until the refresh removes the row.
      setDeleteState({ kind: "deleted", key, scope: rowScope, message: outcome.message });
      setConfirmDelete(null);
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
      // The full fingerprint (32-char hex digest) is copied to the clipboard,
      // not the masked preview shown in the UI. The label makes this explicit
      // (B9) so the operator knows the full digest — not the truncated preview
      // — is what lands in their clipboard.
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
              maxLength={128}
              placeholder="DATABASE_URL"
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
              autoComplete="new-password"
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

      {deleteState.kind === "deleted" ? (
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
              const id = rowId(record.scope, record.key);
              const isDeleting = deleteState.kind === "deleting" && deleteState.key === record.key && deleteState.scope === record.scope;
              const isDeletedRow = deleteState.kind === "deleted" && deleteState.key === record.key && deleteState.scope === record.scope;
              // Lock the row for the whole delete lifecycle (B4): while the
              // request is in flight AND after it succeeds, until refresh
              // removes the row. This blocks a second DELETE click in the gap
              // between the state flipping to "deleted" and router.refresh()
              // repainting the list.
              const isRowLocked = isDeleting || isDeletedRow;
              const isCopyingThis = copyState.key === id;
              const isConfirmOpen = confirmDelete?.key === record.key && confirmDelete?.scope === record.scope;
              return (
                <TableRow key={id} data-testid={`env-value-row-${id}`}>
                  <TableCell className="font-mono text-xs">{record.key}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{record.scope}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-xs" data-testid={`env-value-fingerprint-${id}`}>
                        {maskFingerprint(fingerprint)}
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => fingerprint ? onCopyFingerprint(fingerprint, id) : undefined}
                        disabled={!fingerprint}
                        aria-label={`Copy full fingerprint for ${record.key}`}
                        data-testid={`env-value-copy-${id}`}
                      >
                        {isCopyingThis && copyState.message ? copyState.message : "Copy full fingerprint"}
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatTimestamp(record.updatedAt)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatTimestamp(record.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Dialog
                      open={isConfirmOpen}
                      onOpenChange={(next) => {
                        if (deleting) return;
                        if (next) {
                          // Opening a fresh confirmation: clear any prior error
                          // so it does not leak from a previous row's failed
                          // delete into this row's dialog.
                          setDeleteState({ kind: "idle" });
                          setConfirmDelete({ key: record.key, scope: record.scope });
                        } else {
                          setConfirmDelete(null);
                          if (deleteState.kind === "error") setDeleteState({ kind: "idle" });
                        }
                      }}
                    >
                      <DialogTrigger
                        render={
                          <Button
                            type="button"
                            size="xs"
                            variant="destructive"
                            disabled={isRowLocked || pending}
                            aria-busy={isDeleting}
                            data-testid={`env-value-delete-${id}`}
                          >
                            {isDeleting ? "Removing..." : "Remove"}
                          </Button>
                        }
                      />
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Remove env value for {record.key}?</DialogTitle>
                          <DialogDescription>
                            This permanently removes the encrypted secret value for the {record.scope} scope. The env metadata key stays; paste a new value to set it again.
                          </DialogDescription>
                        </DialogHeader>
                        {deleteState.kind === "error" ? (
                          <Alert data-testid={`env-value-delete-error-${id}`} role="alert">
                            <AlertDescription>{deleteState.message}</AlertDescription>
                          </Alert>
                        ) : null}
                        <DialogFooter>
                          <DialogClose render={<Button type="button" variant="outline" disabled={deleting}>Cancel</Button>} />
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={() => {
                              void onConfirmDelete(record.key, record.scope);
                            }}
                            disabled={deleting}
                            data-testid={`env-value-delete-confirm-${id}`}
                          >
                            {isDeleting ? "Removing..." : "Remove value"}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
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
