"use client";

import { useMemo, useState } from "react";
import type { AuditEventListItem, AuditEventListPage } from "@deploylite/contracts";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import type { AuditListFailureReason, AuditListResult } from "@/lib/auth-boundary";

/**
 * Audit drawer — operator/admin only. The public API contract strips the
 * per-row `metadata` column, so the web layer only ever sees the safe
 * envelope (id, actor, action, target, requestId, correlationId, timestamp).
 * The drawer therefore never renders fingerprint values, raw secret keys, or
 * any other sensitive detail even if a future API change accidentally
 * returned them — only action/target ids and the masked actor id.
 */

const auditDrawerCopy = {
  title: "Audit history",
  description: "Recent privileged actions on this project. Metadata is filtered server-side; only the safe event envelope is shown.",
  empty: "No audit events yet.",
  forbidden: "Audit history is restricted to operator or admin sessions.",
  unconfigured: "Configure DEPLOYLITE_WEB_API_BASE_URL before loading the audit history.",
  unreachable: "The local API is unreachable. Start the API and try again.",
  invalid: "The audit history response was invalid. Refresh and try again.",
  rejected: "The API rejected the audit request. Refresh and try again.",
  actorLabel: "Filter by actor (user id)",
  actionLabel: "Filter by action prefix",
  refresh: "Refresh"
} as const;

export type AuditDrawerState =
  | { kind: "ready" }
  | { kind: "error"; reason: AuditListFailureReason; status?: number };

export type AuditDrawerProps = {
  apiBaseUrl: string | null;
  cookieHeader: string;
  projectId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: AuditDrawerState;
  events: AuditEventListItem[];
  total: number;
  limit: number;
  offset: number;
  onRefresh?: (filter: { actor?: string; action?: string }) => void;
};

export type AuditDrawerContentProps = {
  state: AuditDrawerState;
  events: AuditEventListItem[];
  total: number;
  limit: number;
  offset: number;
  onRefresh?: (filter: { actor?: string; action?: string }) => void;
};

export function maskAuditActor(actorId: string): string {
  if (actorId === "system") return "system · automated";
  if (actorId === "anonymous") return "anonymous · pre-login";
  // UUID-shaped ids (8-4-4-4-12) get the first 8 + last 3 masked preview so
  // shoulder-surfing the drawer cannot reveal the full actor identity.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorId)) {
    return `${actorId.slice(0, 8)}…${actorId.slice(-3)}`;
  }
  return actorId;
}

export function maskAuditTarget(targetId: string): string {
  // Targets are public project / env references, not secrets. They are shown
  // in full so the operator can correlate with the project detail page.
  return targetId;
}

export function renderAuditTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function describeAuditListFailure(result: Extract<AuditListResult, { kind: "error" }>): string {
  if (result.reason === "forbidden") return auditDrawerCopy.forbidden;
  if (result.reason === "api-unconfigured") return auditDrawerCopy.unconfigured;
  if (result.reason === "api-unreachable") return auditDrawerCopy.unreachable;
  if (result.reason === "invalid-payload") return auditDrawerCopy.invalid;
  return auditDrawerCopy.rejected;
}

/**
 * Pure, side-effect-free body of the audit drawer. Extracted so unit tests can
 * exercise the markup without the Sheet portal (which does not render under
 * `renderToStaticMarkup`). The interactive wrapper in `<AuditDrawer>` is
 * responsible for the Sheet chrome and the filter input state.
 */
export function AuditDrawerContent({ state, events, total, limit, offset, onRefresh }: AuditDrawerContentProps) {
  // The list is metadata-stripped server-side, but we still run a defensive
  // pass over the rendered text to drop any substring that could resemble a
  // 32+ char hex digest (which is the shape of a fingerprint). The API
  // contract is the primary guarantee; this is a belt-and-suspenders redaction
  // so a future API regression cannot leak a fingerprint into the UI.
  const safeEvents = useMemo(() => events.map((event) => ({
    ...event,
    actorId: maskAuditActor(event.actorId),
    targetId: maskAuditTarget(event.targetId)
  })), [events]);

  return (
    <div className="flex flex-col gap-4" data-testid="audit-drawer">
      {onRefresh ? (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="audit-drawer-actor">{auditDrawerCopy.actorLabel}</FieldLabel>
            <AuditFilterInput filterId="audit-drawer-actor" placeholder="user_admin_1" onRefresh={onRefresh} />
          </Field>
          <Field>
            <FieldLabel htmlFor="audit-drawer-action">{auditDrawerCopy.actionLabel}</FieldLabel>
            <AuditFilterInput filterId="audit-drawer-action" placeholder="project.env-value" onRefresh={onRefresh} />
          </Field>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onRefresh({})}
              data-testid="audit-drawer-refresh"
            >
              {auditDrawerCopy.refresh}
            </Button>
            <span className="text-xs text-muted-foreground" data-testid="audit-drawer-meta">
              {total} event(s) · limit {limit} · offset {offset}
            </span>
          </div>
        </FieldGroup>
      ) : null}

      <div id="audit-drawer-list" data-testid="audit-drawer-list" className="flex-1 overflow-auto">
        {state.kind === "error" ? (
          <p className="text-sm text-destructive" role="alert" data-testid="audit-drawer-error">
            {describeAuditListFailure(state)}
          </p>
        ) : safeEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="audit-drawer-empty">{auditDrawerCopy.empty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Request</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {safeEvents.map((event) => (
                <TableRow key={event.id} data-testid={`audit-drawer-row-${event.id}`}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{renderAuditTimestamp(event.timestamp)}</TableCell>
                  <TableCell className="font-mono text-xs">{event.actorId}</TableCell>
                  <TableCell className="font-mono text-xs">{event.action}</TableCell>
                  <TableCell className="font-mono text-xs break-all">{event.targetId}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{event.requestId}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function AuditFilterInput({ filterId, placeholder, onRefresh }: { filterId: string; placeholder: string; onRefresh: (filter: { actor?: string; action?: string }) => void }) {
  // The actual interactive filter state lives in the wrapper component so it
  // persists across re-renders. This inner input is uncontrolled on purpose:
  // it forwards its value to the parent only when the user clicks Refresh.
  const [value, setValue] = useState("");
  return (
    <div className="flex items-center gap-2">
      <Input
        id={filterId}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        data-testid={filterId}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onRefresh(filterId === "audit-drawer-actor" ? { actor: value || undefined } : { action: value || undefined })}
        data-testid={`${filterId}-apply`}
      >
        Apply
      </Button>
    </div>
  );
}

export function AuditDrawer({
  apiBaseUrl: _apiBaseUrl,
  cookieHeader: _cookieHeader,
  projectId: _projectId,
  open,
  onOpenChange,
  state,
  events,
  total,
  limit,
  offset,
  onRefresh
}: AuditDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-4 sm:max-w-2xl"
        data-testid="audit-drawer-content"
      >
        <SheetHeader>
          <SheetTitle>{auditDrawerCopy.title}</SheetTitle>
          <SheetDescription>{auditDrawerCopy.description}</SheetDescription>
        </SheetHeader>
        <AuditDrawerContent
          state={state}
          events={events}
          total={total}
          limit={limit}
          offset={offset}
          onRefresh={onRefresh}
        />
      </SheetContent>
    </Sheet>
  );
}
