import { z } from "zod";

export const deployLiteEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEPLOYLITE_API_URL: z.string().url().default("http://localhost:3001"),
  DATABASE_URL: z.string().url().optional(),
  DEPLOYLITE_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 8),
  DEPLOYLITE_SESSION_COOKIE_NAME: z.string().min(1).default("deploylite_session"),
  DEPLOYLITE_SESSION_COOKIE_SECURE: z.coerce.boolean().optional(),
  DEPLOYLITE_BCRYPT_COST: z.coerce.number().int().min(10).max(14).default(12)
});

export type DeployLiteEnv = z.infer<typeof deployLiteEnvSchema>;

export function parseDeployLiteEnv(input: NodeJS.ProcessEnv): DeployLiteEnv {
  return deployLiteEnvSchema.parse(input);
}
