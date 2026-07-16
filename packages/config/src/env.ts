import { z } from "zod";

const booleanString = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return value;
}, z.boolean());

export const deployLiteEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEPLOYLITE_API_URL: z.string().url().default("http://localhost:3001"),
  DEPLOYLITE_CORS_ORIGIN: z.string().url().optional(),
  DEPLOYLITE_API_HOST: z.string().min(1).default("127.0.0.1"),
  DEPLOYLITE_API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  DATABASE_URL: z.string().url().optional(),
  DEPLOYLITE_SECRET_KEY: z.string().min(1).optional(),
  DEPLOYLITE_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 8),
  DEPLOYLITE_SESSION_COOKIE_NAME: z.string().min(1).default("deploylite_session"),
  DEPLOYLITE_SESSION_COOKIE_SECURE: booleanString.optional(),
  DEPLOYLITE_BCRYPT_COST: z.coerce.number().int().min(10).max(14).default(12),
  DEPLOYLITE_CONTROL_PLANE_CONFIRMED_DELETE: booleanString.default(false),
  DEPLOYLITE_REPOSITORY_ALLOWLIST: z.string().optional(),
  DEPLOYLITE_IMAGE_ALLOWLIST: z.string().optional(),
  DEPLOYLITE_ADMISSION_MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().optional(),
  DEPLOYLITE_ADMISSION_MAX_RATE_PER_MINUTE: z.coerce.number().int().positive().optional(),
  DEPLOYLITE_ADMISSION_MAX_CONCURRENCY: z.coerce.number().int().positive().optional(),
  DEPLOYLITE_ADMISSION_MAX_CPU_CORES: z.coerce.number().positive().optional(),
  DEPLOYLITE_ADMISSION_MAX_MEMORY_MIB: z.coerce.number().int().positive().optional()
});

export type DeployLiteEnv = z.infer<typeof deployLiteEnvSchema>;

export function parseDeployLiteEnv(input: NodeJS.ProcessEnv): DeployLiteEnv {
  return deployLiteEnvSchema.parse(input);
}

export type AdmissionRequest = {
  repositoryUrl: string; image: string; payloadBytes: number; ratePerMinute: number; concurrentCommands: number; cpuCores: number; memoryMiB: number;
};

function deny(code: string): never { throw new Error(code); }
function allowlist(value: string | undefined, defaults: string): string[] {
  return (value ?? defaults).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}
function isPrivateHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

function canonicalRepository(input: string, allowlist: readonly string[]): string {
  let url: URL;
  try { url = new URL(input); } catch { return deny("REPOSITORY_INVALID"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || isPrivateHost(host) || !allowlist.includes(host)) return deny("REPOSITORY_DENIED");
  const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  if (!path || path === "/") return deny("REPOSITORY_INVALID");
  return `https://${host}${path}`;
}

function canonicalImage(input: string, allowlist: readonly string[], production: boolean): string {
  const match = /^([a-z0-9.-]+)\/([a-z0-9._/-]+)(?::([a-zA-Z0-9._-]+))?$/.exec(input.trim().toLowerCase());
  if (!match) return deny("IMAGE_INVALID");
  const host = match[1]!;
  const path = match[2]!;
  const tag = match[3];
  if (!path.split("/").every(isValidImagePathSegment)) return deny("IMAGE_INVALID");
  if (isPrivateHost(host) || !allowlist.includes(host)) return deny("IMAGE_DENIED");
  if (production && (!tag || tag === "latest")) return deny("IMAGE_MUTABLE_TAG");
  return `${host}/${path}${tag ? `:${tag}` : ""}`;
}

function isValidImagePathSegment(segment: string): boolean {
  return /^[a-z0-9]+(?:[._]|__|[-]*[a-z0-9]+)*$/.test(segment);
}

export function admitControlPlaneRequest(env: DeployLiteEnv, request: AdmissionRequest): { repositoryUrl: string; image: string } {
  const repositoryUrl = canonicalRepository(request.repositoryUrl, allowlist(env.DEPLOYLITE_REPOSITORY_ALLOWLIST, "github.com,gitlab.com"));
  const image = canonicalImage(request.image, allowlist(env.DEPLOYLITE_IMAGE_ALLOWLIST, "docker.io,ghcr.io"), env.NODE_ENV === "production");
  if (request.payloadBytes > (env.DEPLOYLITE_ADMISSION_MAX_PAYLOAD_BYTES ?? 65_536)) deny("PAYLOAD_LIMIT_EXCEEDED");
  if (request.ratePerMinute > (env.DEPLOYLITE_ADMISSION_MAX_RATE_PER_MINUTE ?? 20)) deny("RATE_LIMIT_EXCEEDED");
  if (request.concurrentCommands > (env.DEPLOYLITE_ADMISSION_MAX_CONCURRENCY ?? 1)) deny("CONCURRENCY_LIMIT_EXCEEDED");
  if (request.cpuCores > (env.DEPLOYLITE_ADMISSION_MAX_CPU_CORES ?? 4) || request.memoryMiB > (env.DEPLOYLITE_ADMISSION_MAX_MEMORY_MIB ?? 8_192)) deny("RESOURCE_LIMIT_EXCEEDED");
  return { repositoryUrl, image };
}
