"use client";

import type { LogEvent } from "@deploylite/contracts";
import { useDeploymentStream } from "@/lib/use-deployment-stream";

export function DeploymentLiveLog({ deploymentId, apiBaseUrl, events }: { deploymentId: string; apiBaseUrl: string | null; events: LogEvent[] }) {
  const stream = useDeploymentStream({ deploymentId, apiBaseUrl, initialEvents: events });
  return <div data-testid="deployment-live-log" aria-live="polite">
    <p className="mb-3 text-sm text-muted-foreground">Live log stream: {stream.state}</p>
    {stream.events.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="log-empty-state">No log events are available yet.</p> : <pre className="overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">{stream.events.map((event) => `${event.sequence} ${event.level.toUpperCase()} ${event.message}`).join("\n")}</pre>}
  </div>;
}
