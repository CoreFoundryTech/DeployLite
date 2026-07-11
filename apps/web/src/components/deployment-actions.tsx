"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { Deployment } from "@deploylite/contracts";

type Action = "cancel" | "restart" | "rollback";
type Result =
  | { kind: "success" }
  | { kind: "idempotent" }
  | { kind: "error" | "terminal" | "unavailable"; message: string };

export type DeploymentActionsProps = { deployment: Deployment; apiBaseUrl: string | null; onComplete?: () => void };
export type DeploymentActionOptions = { deploymentId: string; action: Action; apiBaseUrl: string | null; fetchImpl?: typeof fetch };

const copy = {
  unconfigured: "Deployment controls are unavailable until the API URL is configured.",
  unauthorized: "Your session cannot perform this deployment action. Sign in again or ask an administrator.",
  missing: "This deployment is no longer available. Refresh the page.",
  unavailable: "This action is not available for this deployment.",
  rejected: "The deployment action could not be completed. Refresh and try again.",
  unreachable: "The local API is unreachable. Start the API and try again."
} as const;

export async function runDeploymentAction({ deploymentId, action, apiBaseUrl, fetchImpl = fetch }: DeploymentActionOptions): Promise<Result> {
  if (!apiBaseUrl) return { kind: "error", message: copy.unconfigured };
  try {
    const response = await fetchImpl(new URL(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/${action}`, apiBaseUrl), {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}"
    });
    const payload = await response.json().catch(() => null) as { data?: { idempotent?: unknown } } | null;
    if (response.ok) return payload?.data?.idempotent === true ? { kind: "idempotent" } : { kind: "success" };
    if (response.status === 401 || response.status === 403) return { kind: "error", message: copy.unauthorized };
    if (response.status === 404) return { kind: "error", message: copy.missing };
    if (response.status === 409 && action !== "cancel") return { kind: "unavailable", message: copy.unavailable };
    if (response.status === 409) return { kind: "terminal", message: "This deployment has already reached a terminal state." };
    return { kind: "error", message: copy.rejected };
  } catch {
    return { kind: "error", message: copy.unreachable };
  }
}

export function DeploymentActions({ deployment, apiBaseUrl, onComplete }: DeploymentActionsProps) {
  const [pending, setPending] = useState<Action | null>(null);
  const [unavailable, setUnavailable] = useState<Set<Action>>(() => new Set());
  const [message, setMessage] = useState<string | null>(null);
  const terminal = deployment.status === "succeeded" || deployment.status === "failed" || deployment.status === "canceled";

  async function submit(action: Action) {
    if (pending) return;
    setPending(action);
    setMessage(null);
    const result = await runDeploymentAction({ deploymentId: deployment.id, action, apiBaseUrl });
    if (result.kind === "unavailable") setUnavailable((current) => new Set(current).add(action));
    if (result.kind === "success") setMessage(`${action[0]?.toUpperCase()}${action.slice(1)} requested.`);
    else if (result.kind === "idempotent") setMessage("The deployment was already in its requested state.");
    else setMessage(result.message);
    setPending(null);
    if (result.kind === "success" || result.kind === "idempotent") onComplete?.();
  }

  return (
    <section aria-label="Deployment actions" className="flex flex-col gap-3" data-testid="deployment-actions">
      <div className="flex flex-wrap gap-2">
        <ConfirmAction action="cancel" label="Cancel deployment" destructive disabled={!apiBaseUrl || terminal || unavailable.has("cancel") || Boolean(pending)} pending={pending === "cancel"} onConfirm={submit} />
        <ActionButton action="restart" label="Restart" disabled={!apiBaseUrl || unavailable.has("restart") || Boolean(pending)} pending={pending === "restart"} onClick={submit} />
        <ConfirmAction action="rollback" label="Rollback" disabled={!apiBaseUrl || unavailable.has("rollback") || Boolean(pending)} pending={pending === "rollback"} onConfirm={submit} />
      </div>
      {message ? <Alert variant={message.endsWith("requested.") || message.startsWith("The deployment was already") ? "default" : "destructive"} role={message.endsWith("requested.") || message.startsWith("The deployment was already") ? "status" : "alert"}><AlertDescription>{message}</AlertDescription></Alert> : null}
    </section>
  );
}

function ActionButton({ action, label, disabled, pending, onClick }: { action: Action; label: string; disabled: boolean; pending: boolean; onClick: (action: Action) => void }) {
  return <Button type="button" variant="outline" disabled={disabled} onClick={() => void onClick(action)}>{pending ? `${label}…` : label}</Button>;
}

function ConfirmAction({ action, label, destructive, disabled, pending, onConfirm }: { action: Action; label: string; destructive?: boolean; disabled: boolean; pending: boolean; onConfirm: (action: Action) => void }) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
    <DialogTrigger render={<Button type="button" variant={destructive ? "destructive" : "outline"} disabled={disabled}>{label}</Button>} />
    <DialogContent>
      <DialogHeader><DialogTitle>{label}?</DialogTitle><DialogDescription>{action === "cancel" ? "Stop the queued or running deployment." : "Return to the last verified deployment when one is available."}</DialogDescription></DialogHeader>
      <DialogFooter><DialogClose render={<Button type="button" variant="outline" disabled={pending}>Keep current deployment</Button>} /><Button type="button" variant={destructive ? "destructive" : "default"} disabled={pending} onClick={() => { void onConfirm(action); setOpen(false); }}>{pending ? "Submitting…" : label}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
