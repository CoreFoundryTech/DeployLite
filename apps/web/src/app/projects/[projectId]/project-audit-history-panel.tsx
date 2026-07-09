"use client";

import { useState } from "react";
import type { AuditEventListItem } from "@deploylite/contracts";
import { loadAuditEvents, type AuditListFailureReason } from "@/lib/auth-boundary";
import { AuditDrawer, type AuditDrawerState, type AuditRefreshHandler } from "@/components/audit-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * In-page audit history panel for a project. Renders a small summary table of
 * the latest events and a button that opens the full <AuditDrawer/> with
 * filterable history. The component owns the drawer's open state and keeps
 * the rendered preview in sync with the data the parent (server component)
 * fetched on first paint.
 */

type AuditHistoryFailure = { kind: "error"; reason: AuditListFailureReason; status?: number };

export type ProjectAuditHistoryPanelProps = {
  apiBaseUrl: string | null;
  cookieHeader: string;
  projectId: string;
  initialEvents: AuditEventListItem[];
  initialTotal: number;
  initialState: AuditDrawerState;
};

export function ProjectAuditHistoryPanel({
  apiBaseUrl,
  cookieHeader,
  projectId,
  initialEvents,
  initialTotal,
  initialState
}: ProjectAuditHistoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<AuditEventListItem[]>(initialEvents);
  const [total, setTotal] = useState(initialTotal);
  const [state, setState] = useState<AuditDrawerState>(initialState);
  const [limit] = useState(50);
  const [offset] = useState(0);

  // The drawer accepts a sync OR async refresh callback; this handler is
  // async because the API roundtrip awaits the response before the
  // preview state can be updated. The drawer swallows the returned
  // promise internally, so the parent does not need a fire-and-forget
  // wrapper.
  const onRefresh: AuditRefreshHandler = async (filter) => {
    const result = await loadAuditEvents({
      apiBaseUrl: apiBaseUrl ?? undefined,
      cookieHeader,
      projectId,
      actor: filter.actor,
      action: filter.action,
      limit,
      offset
    });
    if (result.kind === "ready") {
      setEvents(result.data.events);
      setTotal(result.data.total);
      setState({ kind: "ready" });
    } else {
      setEvents([]);
      setTotal(0);
      setState({ kind: "error", reason: result.reason, status: result.status });
    }
  };

  if (initialState.kind === "error" && initialState.reason === "forbidden") {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2 py-6 text-sm text-muted-foreground">
          <span>Audit history is restricted to operator or admin sessions.</span>
        </CardContent>
      </Card>
    );
  }

  const previewEvents = events.slice(0, 5);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground" data-testid="project-audit-summary">
          {total} event(s) in the most recent window.
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="project-audit-open-drawer"
        >
          Open full audit history
        </Button>
      </div>

      {previewEvents.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="project-audit-empty">
          No audit events yet. The first privileged action will appear here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="project-audit-preview">
          {previewEvents.map((event) => (
            <li key={event.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <div className="flex flex-col gap-1">
                <span className="font-mono text-xs">{event.action}</span>
                <span className="text-xs text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{event.targetType}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{event.targetId}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AuditDrawer
        apiBaseUrl={apiBaseUrl}
        cookieHeader={cookieHeader}
        projectId={projectId}
        open={open}
        onOpenChange={setOpen}
        state={state}
        events={events}
        total={total}
        limit={limit}
        offset={offset}
        onRefresh={onRefresh}
      />
    </div>
  );
}
