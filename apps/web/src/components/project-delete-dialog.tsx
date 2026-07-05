"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactElement } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { deleteProject, type DeleteProjectResult } from "@/lib/auth-boundary";

export type ProjectDeleteDialogProps = {
  projectId: string;
  projectName: string;
  apiBaseUrl: string | null;
  cookieHeader: string;
  triggerLabel?: string;
  triggerVariant?: "destructive" | "outline";
  trigger?: ReactElement;
};

export type RunProjectDeleteOptions = {
  projectId: string;
  apiBaseUrl: string | null;
  cookieHeader: string;
  fetchImpl?: typeof fetch;
};

export type RunProjectDeleteOutcome =
  | { kind: "deleted"; redirectPath: string }
  | { kind: "error"; redirectPath: null; message: string };

const deleteCopy = {
  unconfigured: "Configure DEPLOYLITE_WEB_API_BASE_URL before deleting projects.",
  forbidden: "You do not have permission to delete this project.",
  notFound: "This project is already gone. Reload the projects list.",
  rejected: "The project could not be deleted. Refresh and try again.",
  invalid: "Delete response was invalid. Refresh and try again.",
  unreachable: "The local API is unreachable. Start the API and try again."
} as const;

function describeDeleteFailure(result: Extract<DeleteProjectResult, { kind: "error" }>): string {
  if (result.reason === "api-unconfigured") return deleteCopy.unconfigured;
  if (result.reason === "not-found") return deleteCopy.notFound;
  if (result.reason === "api-rejected") {
    return result.status === 403 ? deleteCopy.forbidden : deleteCopy.rejected;
  }
  if (result.reason === "invalid-payload") return deleteCopy.invalid;
  return deleteCopy.unreachable;
}

export async function runProjectDelete({ projectId, apiBaseUrl, cookieHeader, fetchImpl }: RunProjectDeleteOptions): Promise<RunProjectDeleteOutcome> {
  const result = await deleteProject(projectId, { apiBaseUrl: apiBaseUrl ?? undefined, cookieHeader, fetchImpl });
  if (result.kind === "deleted") {
    return { kind: "deleted", redirectPath: "/projects" };
  }
  return { kind: "error", redirectPath: null, message: describeDeleteFailure(result) };
}

export function ProjectDeleteDialog({
  projectId,
  projectName,
  apiBaseUrl,
  cookieHeader,
  triggerLabel = "Delete project",
  triggerVariant = "destructive",
  trigger
}: ProjectDeleteDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function onConfirm() {
    setPending(true);
    setErrorMessage(null);
    const outcome = await runProjectDelete({ projectId, apiBaseUrl, cookieHeader });
    setPending(false);
    if (outcome.kind === "deleted") {
      setOpen(false);
      router.push(outcome.redirectPath);
      router.refresh();
      return;
    }
    setErrorMessage(outcome.message);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (pending) return;
      setErrorMessage(null);
      setOpen(next);
    }}>
      <DialogTrigger
        render={trigger ?? (
          <Button variant={triggerVariant} data-testid="project-delete-trigger">{triggerLabel}</Button>
        )}
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {projectName}?</DialogTitle>
          <DialogDescription>
            This permanently removes the project record. Existing deployments, env metadata, and audit history stay on the server until the next cleanup sweep.
          </DialogDescription>
        </DialogHeader>
        {errorMessage ? (
          <Alert data-testid="project-delete-error" role="alert">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" disabled={pending}>Cancel</Button>} />
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              void onConfirm();
            }}
            disabled={pending}
            data-testid="project-delete-confirm"
          >
            {pending ? "Deleting..." : "Delete project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
