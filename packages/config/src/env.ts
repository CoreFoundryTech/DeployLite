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
  DEPLOYLITE_BCRYPT_COST: z.coerce.number().int().min(10).max(14).default(12)
});

export type DeployLiteEnv = z.infer<typeof deployLiteEnvSchema>;

export function parseDeployLiteEnv(input: NodeJS.ProcessEnv): DeployLiteEnv {
  return deployLiteEnvSchema.parse(input);
}
