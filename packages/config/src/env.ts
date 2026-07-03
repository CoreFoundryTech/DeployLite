import { z } from "zod";

export const deployLiteEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEPLOYLITE_API_URL: z.string().url().default("http://localhost:3001")
});

export type DeployLiteEnv = z.infer<typeof deployLiteEnvSchema>;

export function parseDeployLiteEnv(input: NodeJS.ProcessEnv): DeployLiteEnv {
  return deployLiteEnvSchema.parse(input);
}
