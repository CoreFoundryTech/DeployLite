import type { ProjectUpdateRequest } from "@deploylite/contracts";

const projectDescriptionMaxLength = 2000;

export type ProjectConfigFormValues = {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  buildCommand: string;
  runCommand: string;
  port: string | number | null;
  description?: string | null;
};

type CurrentProjectConfig = {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  buildCommand: string | null;
  runCommand: string | null;
  port: number | null;
  description: string | null;
};

export type NormalizeProjectConfigUpdateResult =
  | { ok: true; payload: ProjectUpdateRequest }
  | { ok: false; message: string };

export function normalizeProjectConfigUpdate(
  current: CurrentProjectConfig,
  values: ProjectConfigFormValues
): NormalizeProjectConfigUpdateResult {
  const name = values.name.trim();
  if (!name) return { ok: false, message: "Project name is required." };

  const repoUrl = values.repoUrl.trim();
  if (!isValidUrl(repoUrl)) return { ok: false, message: "Repository URL must be a valid URL." };

  const defaultBranch = values.defaultBranch.trim();
  if (!defaultBranch) return { ok: false, message: "Default branch is required." };

  const portResult = normalizePort(values.port);
  if (!portResult.ok) return portResult;

  const descriptionResult = normalizeDescription(values.description);
  if (!descriptionResult.ok) return descriptionResult;

  const payload: ProjectUpdateRequest = {};
  if (name !== current.name) payload.name = name;
  if (repoUrl !== current.repoUrl) payload.repoUrl = repoUrl;
  if (defaultBranch !== current.defaultBranch) payload.defaultBranch = defaultBranch;

  assignOptionalString(payload, "buildCommand", values.buildCommand, current.buildCommand);
  assignOptionalString(payload, "runCommand", values.runCommand, current.runCommand);
  if (portResult.port !== current.port) payload.port = portResult.port;
  if (descriptionResult.changed) payload.description = descriptionResult.description;

  return { ok: true, payload };
}

function assignOptionalString(
  payload: ProjectUpdateRequest,
  key: "buildCommand" | "runCommand",
  rawValue: string,
  currentValue: string | null
) {
  const nextValue = rawValue.trim();
  const normalized = nextValue.length > 0 ? nextValue : null;
  if (normalized !== currentValue) {
    payload[key] = normalized;
  }
}

function normalizeDescription(rawDescription: string | null | undefined): { ok: true; description: string | null; changed: boolean } | { ok: false; message: string } {
  if (rawDescription === undefined) {
    return { ok: true, description: null, changed: false };
  }
  const trimmed = (rawDescription ?? "").trim();
  if (trimmed.length > projectDescriptionMaxLength) {
    return { ok: false, message: `Project description must be ${projectDescriptionMaxLength} characters or fewer.` };
  }
  return { ok: true, description: trimmed.length > 0 ? trimmed : null, changed: true };
}

function normalizePort(rawPort: string | number | null): { ok: true; port: number | null } | { ok: false; message: string } {
  const value = rawPort === null ? "" : String(rawPort).trim();
  if (!value) return { ok: true, port: null };
  if (!/^\d+$/.test(value)) return { ok: false, message: "Port must be a whole number between 1 and 65535." };
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) return { ok: false, message: "Port must be a whole number between 1 and 65535." };
  return { ok: true, port };
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
