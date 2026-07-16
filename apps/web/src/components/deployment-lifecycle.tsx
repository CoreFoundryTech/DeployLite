"use client";

import { useEffect, useMemo, useState } from "react";
import type { Deployment, LogEvent } from "@deploylite/contracts";
import { Button } from "@/components/ui/button";

type LifecycleAction = "cancel" | "restart" | "rollback";
type StreamState = "connecting" | "connected" | "reconnecting" | "complete" | "error";

type DeploymentLifecycleProps = {
  deployment: Deployment;
  initialLogs: LogEvent[];
  apiBaseUrl: string | null;
};

type ControlResult =
  | { kind: "success"; deployment: Deployment; idempotent: boolean }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

type DeploymentStreamEvent = { data: string };
type DeploymentEventSource = {
  close: () => void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener: (type: string, listener: (event: DeploymentStreamEvent) => void) => void;
};

type DeploymentStreamOptions = {
  apiBaseUrl: string;
  deploymentId: string;
  afterSequence: number | null;
  onLog: (log: LogEvent) => void;
  onStatus: (deployment: Partial<Deployment>) => void;
  onTerminal: (deployment: Partial<Deployment>) => void;
  onNotice: (message: string) => void;
  onState: (state: StreamState) => void;
  eventSourceFactory?: (url: string, init: EventSourceInit) => DeploymentEventSource;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
};

const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);

export function orderDeploymentLogs(logs: LogEvent[]): LogEvent[] {
  return [...new Map(logs.map((log) => [log.sequence, log])).values()].sort((left, right) => left.sequence - right.sequence);
}

export function redactDeploymentLogMessage(message: string): string {
  return message
    .replace(/\b((?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|KEY|URL))=\S+/g, "$1=[redacted]")
    .replace(/:\/\/([^:\s/]+):[^@\s/]+@/g, "://$1:[redacted]@");
}

export function deploymentStreamUrl(apiBaseUrl: string, deploymentId: string, afterSequence: number | null): string {
  const url = new URL(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/logs/stream`, apiBaseUrl);
  if (afterSequence !== null) url.searchParams.set("afterSequence", String(afterSequence));
  return url.toString();
}

export function streamReconnectDelay(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** Math.min(attempt, 4));
}

export function openDeploymentLifecycleStream({
  apiBaseUrl,
  deploymentId,
  afterSequence,
  onLog,
  onStatus,
  onTerminal,
  onNotice,
  onState,
  eventSourceFactory = (url, init) => new EventSource(url, init),
  schedule = setTimeout,
  clearSchedule = clearTimeout
}: DeploymentStreamOptions): () => void {
  let source: DeploymentEventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let attempts = 0;

  const connect = () => {
    if (closed) return;
    onState(attempts === 0 ? "connecting" : "reconnecting");
    source = eventSourceFactory(deploymentStreamUrl(apiBaseUrl, deploymentId, afterSequence), { withCredentials: true });
    source.onopen = () => { attempts = 0; onState("connected"); };
    source.addEventListener("deployment.log", (event) => {
      try {
        const next = JSON.parse(event.data) as LogEvent;
        onLog({ ...next, message: redactDeploymentLogMessage(next.message), redactionApplied: true });
      } catch { onNotice("A lifecycle log frame was ignored because it was invalid."); }
    });
    source.addEventListener("deployment.status", (event) => {
      try { onStatus(JSON.parse(event.data) as Partial<Deployment>); } catch { onNotice("A lifecycle status frame was ignored because it was invalid."); }
    });
    source.addEventListener("deployment.terminal", (event) => {
      try {
        const next = JSON.parse(event.data) as Partial<Deployment>;
        if (!next || typeof next !== "object" || !terminalStatuses.has(next.status ?? "")) throw new Error("Invalid terminal deployment status");
        onTerminal(next);
        onState("complete");
        source?.close();
      } catch { onNotice("A lifecycle terminal frame was ignored because it was invalid."); }
    });
    source.onerror = () => {
      source?.close();
      if (closed) return;
      attempts += 1;
      onState("reconnecting");
      retry = schedule(connect, streamReconnectDelay(attempts));
    };
  };

  connect();
  return () => { closed = true; source?.close(); if (retry) clearSchedule(retry); };
}

export async function runDeploymentControl({
  deploymentId,
  action,
  apiBaseUrl,
  fetchImpl = fetch
}: {
  deploymentId: string;
  action: LifecycleAction;
  apiBaseUrl: string | null;
  fetchImpl?: typeof fetch;
}): Promise<ControlResult> {
  if (!apiBaseUrl) return { kind: "error", message: "Configure DEPLOYLITE_WEB_API_BASE_URL before managing this deployment." };
  try {
    const response = await fetchImpl(new URL(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/${action}`, apiBaseUrl), {
      method: "POST",
      credentials: "include"
    });
    const payload = await response.json() as { data?: { deployment?: Deployment; idempotent?: boolean }; error?: { code?: string; message?: string } };
    if (response.ok && payload.data?.deployment) {
      return { kind: "success", deployment: payload.data.deployment, idempotent: payload.data.idempotent === true };
    }
    if (response.status === 409 && (payload.error?.code === "EXECUTOR_CAPABILITY_UNAVAILABLE" || payload.error?.code === "ROLLBACK_UNAVAILABLE")) {
      return { kind: "unavailable", message: payload.error.message ?? `${action} is unavailable for this deployment.` };
    }
    return { kind: "error", message: payload.error?.message ?? `Could not ${action} this deployment. Refresh and try again.` };
  } catch {
    return { kind: "error", message: "The local API is unreachable. Deployment state may be stale; retry after it reconnects." };
  }
}

export function DeploymentLifecycle({ deployment: initialDeployment, initialLogs, apiBaseUrl }: DeploymentLifecycleProps) {
  const [deployment, setDeployment] = useState(initialDeployment);
  const [logs, setLogs] = useState(() => orderDeploymentLogs(initialLogs));
  const [streamState, setStreamState] = useState<StreamState>(terminalStatuses.has(initialDeployment.status) ? "complete" : "connecting");
  const [actionPending, setActionPending] = useState<LifecycleAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lastSequence = logs.at(-1)?.sequence ?? null;
  const terminal = terminalStatuses.has(deployment.status);

  useEffect(() => {
    if (!apiBaseUrl || terminal || typeof EventSource === "undefined") return;
    return openDeploymentLifecycleStream({
      apiBaseUrl,
      deploymentId: deployment.id,
      afterSequence: lastSequence,
      onLog: (next) => setLogs((current) => orderDeploymentLogs([...current, next])),
      onStatus: (next) => setDeployment((current) => ({ ...current, ...next })),
      onTerminal: (next) => setDeployment((current) => ({ ...current, ...next })),
      onNotice: setNotice,
      onState: setStreamState
    });
  }, [apiBaseUrl, deployment.id, lastSequence, terminal]);

  const orderedLogs = useMemo(() => orderDeploymentLogs(logs), [logs]);
  const performAction = async (action: LifecycleAction) => {
    setActionPending(action);
    const result = await runDeploymentControl({ deploymentId: deployment.id, action, apiBaseUrl });
    if (result.kind === "success") {
      setDeployment(result.deployment);
      setNotice(result.idempotent ? "Cancellation was already applied; the authoritative terminal state is shown." : `${action === "cancel" ? "Cancellation" : action} request accepted.`);
    } else setNotice(result.message);
    setActionPending(null);
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="deployment-lifecycle-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="deployment-lifecycle-title" className="font-semibold">Live lifecycle</h2>
          <p className="text-sm text-muted-foreground">Status: <strong>{deployment.status}</strong> · stream {streamState}</p>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Deployment controls">
          <Button type="button" variant="destructive" disabled={terminal || actionPending !== null} onClick={() => void performAction("cancel")} aria-label={`Cancel deployment ${deployment.id}`}>
            {actionPending === "cancel" ? "Cancelling…" : terminal ? "Deployment is terminal" : "Cancel deployment"}
          </Button>
          <Button type="button" variant="outline" disabled={actionPending !== null} onClick={() => void performAction("restart")}>Restart availability</Button>
          <Button type="button" variant="outline" disabled={actionPending !== null} onClick={() => void performAction("rollback")}>Rollback availability</Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">Restart unavailable until the assigned agent advertises support. Rollback unavailable until a verified prior image is recorded.</p>
      <p role="status" aria-live="polite" className="text-sm" data-testid="deployment-lifecycle-status">{notice ?? (terminal ? "Deployment reached a terminal state." : "Connecting to authoritative lifecycle updates.")}</p>
      {orderedLogs.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="log-empty-state">No log events are available yet.</p> : (
        <ol className="overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed" aria-label="Ordered deployment logs">
          {orderedLogs.map((log) => <li key={log.sequence}>#{log.sequence} {log.level.toUpperCase()} {redactDeploymentLogMessage(log.message)}</li>)}
        </ol>
      )}
    </section>
  );
}
