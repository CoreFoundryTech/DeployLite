import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Local-only state consumed by the container healthcheck; it never holds credentials or error details. */
export type AgentReadiness = {
  markReady(): Promise<void>;
  clear(): Promise<void>;
};

export class FileAgentReadiness implements AgentReadiness {
  constructor(private readonly path: string) {}

  async markReady(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, "ready\n", { mode: 0o600 });
    await rename(temporaryPath, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
