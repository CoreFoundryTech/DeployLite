import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { deploymentCommandSchema, type DeploymentCommand } from "@deploylite/contracts";
import { z } from "zod";
import type { CommandBusClient } from "./executor/index.js";

const MAX_RECORDS = 256;
const MAX_FILE_BYTES = 256 * 1024;
const SAFE_FAILURE_REASON = "Deployment execution failed; details were redacted by the agent.";

const terminalAckRecordSchema = z.object({
  version: z.literal(1),
  commandId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
  action: z.enum(["complete", "fail"]),
  reason: z.string().max(256).optional(),
  createdAt: z.string().datetime({ offset: true })
}).strict();

const outboxFileSchema = z.object({
  version: z.literal(1),
  records: z.array(terminalAckRecordSchema).max(MAX_RECORDS)
}).strict();

export type TerminalAckRecord = z.infer<typeof terminalAckRecordSchema>;

export type TerminalOutbox = {
  load(): Promise<TerminalAckRecord[]>;
  put(record: TerminalAckRecord): Promise<void>;
  remove(commandId: string): Promise<void>;
};

export class CorruptTerminalOutboxError extends Error {
  constructor() {
    super("Terminal acknowledgement outbox is corrupt and was quarantined");
    this.name = "CorruptTerminalOutboxError";
  }
}

export class FileTerminalOutbox implements TerminalOutbox {
  readonly #path: string;
  #records: TerminalAckRecord[] | null = null;

  constructor(path: string) {
    if (!path.startsWith("/")) throw new Error("Terminal outbox path must be absolute");
    this.#path = resolve(path);
  }

  async load(): Promise<TerminalAckRecord[]> {
    if (this.#records) return structuredClone(this.#records);
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      const contents = await readFile(this.#path, { encoding: "utf8" });
      if (Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES) throw new Error("outbox exceeds size limit");
      this.#records = outboxFileSchema.parse(JSON.parse(contents)).records;
      return structuredClone(this.#records);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#records = [];
        return [];
      }
      const quarantinePath = `${this.#path}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
      try {
        await rename(this.#path, quarantinePath);
        await chmod(quarantinePath, 0o600);
      } catch {
        // Keep startup fail-closed even if quarantine itself cannot complete.
      }
      throw new CorruptTerminalOutboxError();
    }
  }

  async put(record: TerminalAckRecord): Promise<void> {
    const parsed = terminalAckRecordSchema.parse(record);
    const records = await this.load();
    const next = [...records.filter((item) => item.commandId !== parsed.commandId), parsed];
    if (next.length > MAX_RECORDS) throw new Error("Terminal acknowledgement outbox is full");
    await this.#persist(next);
  }

  async remove(commandId: string): Promise<void> {
    const records = await this.load();
    const next = records.filter((item) => item.commandId !== commandId);
    if (next.length !== records.length) await this.#persist(next);
  }

  async #persist(records: TerminalAckRecord[]): Promise<void> {
    const contents = JSON.stringify(outboxFileSchema.parse({ version: 1, records }));
    if (Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES) throw new Error("Terminal acknowledgement outbox exceeds size limit");
    const temporaryPath = `${this.#path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.#path);
    await chmod(this.#path, 0o600);
    this.#records = structuredClone(records);
  }
}

export class InMemoryTerminalOutbox implements TerminalOutbox {
  readonly #records = new Map<string, TerminalAckRecord>();
  constructor(records: TerminalAckRecord[] = []) {
    for (const record of records) this.#records.set(record.commandId, terminalAckRecordSchema.parse(record));
  }
  async load(): Promise<TerminalAckRecord[]> { return structuredClone([...this.#records.values()]); }
  async put(record: TerminalAckRecord): Promise<void> { this.#records.set(record.commandId, terminalAckRecordSchema.parse(record)); }
  async remove(commandId: string): Promise<void> { this.#records.delete(commandId); }
}

export class DurableTerminalCommandBus implements CommandBusClient {
  constructor(
    private readonly agentId: string,
    private readonly transport: CommandBusClient,
    private readonly outbox: TerminalOutbox,
    private readonly now: () => Date = () => new Date()
  ) {}

  claim(commandId: string, agentId: string): Promise<DeploymentCommand | null> {
    if (agentId !== this.agentId) throw new Error("Agent identity mismatch");
    return this.transport.claim(commandId, agentId);
  }

  async complete(commandId: string, output?: Record<string, unknown>): Promise<DeploymentCommand | null> {
    await this.outbox.put(this.record(commandId, "complete"));
    const acknowledged = await this.transport.complete(commandId, output);
    await this.assertAndRemove(commandId, "completed", acknowledged);
    return acknowledged;
  }

  async fail(commandId: string, reason: string): Promise<DeploymentCommand | null> {
    await this.outbox.put(this.record(commandId, "fail", SAFE_FAILURE_REASON));
    const acknowledged = await this.transport.fail(commandId, reason);
    await this.assertAndRemove(commandId, "failed", acknowledged);
    return acknowledged;
  }

  async replayPending(): Promise<boolean> {
    const records = await this.outbox.load();
    for (const record of records) {
      if (record.agentId !== this.agentId) throw new Error("Terminal outbox contains a record for another agent");
      try {
        const acknowledged = record.action === "complete"
          ? await this.transport.complete(record.commandId)
          : await this.transport.fail(record.commandId, record.reason ?? SAFE_FAILURE_REASON);
        await this.assertAndRemove(record.commandId, record.action === "complete" ? "completed" : "failed", acknowledged);
      } catch {
        return false;
      }
    }
    return true;
  }

  private record(commandId: string, action: TerminalAckRecord["action"], reason?: string): TerminalAckRecord {
    return terminalAckRecordSchema.parse({ version: 1, commandId, agentId: this.agentId, action, reason, createdAt: this.now().toISOString() });
  }

  private async assertAndRemove(commandId: string, state: "completed" | "failed", command: DeploymentCommand | null): Promise<void> {
    const parsed = deploymentCommandSchema.nullable().parse(command);
    if (!parsed || parsed.id !== commandId || parsed.agentId !== this.agentId || parsed.state !== state) {
      throw new Error("Terminal acknowledgement did not confirm the assigned command state");
    }
    await this.outbox.remove(commandId);
  }
}
