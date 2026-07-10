import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { CleanupRepairRecord, CleanupRepairStore } from "./executor/index.js";

const MAX_RECORDS = 256;
const repairSchema = z.object({
  version: z.literal(1),
  commandId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  projectSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
}).strict();
const fileSchema = z.object({ version: z.literal(1), records: z.array(repairSchema).max(MAX_RECORDS) }).strict();

export class FileCleanupRepairStore implements CleanupRepairStore {
  readonly #path: string;
  #records: CleanupRepairRecord[] | null = null;

  constructor(path: string) {
    if (!path.startsWith("/")) throw new Error("Cleanup repair path must be absolute");
    this.#path = resolve(path);
  }

  async load(): Promise<CleanupRepairRecord[]> {
    if (this.#records) return structuredClone(this.#records);
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      this.#records = fileSchema.parse(JSON.parse(await readFile(this.#path, "utf8"))).records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cleanup repair state is invalid");
      this.#records = [];
    }
    return structuredClone(this.#records);
  }

  async put(record: CleanupRepairRecord): Promise<void> {
    const parsed = repairSchema.parse(record);
    const records = await this.load();
    const next = [...records.filter((item) => item.commandId !== parsed.commandId), parsed];
    if (next.length > MAX_RECORDS) throw new Error("Cleanup repair state is full");
    await this.#persist(next);
  }

  async remove(commandId: string): Promise<void> {
    const records = await this.load();
    const next = records.filter((item) => item.commandId !== commandId);
    if (next.length !== records.length) await this.#persist(next);
  }

  async #persist(records: CleanupRepairRecord[]): Promise<void> {
    const temporary = `${this.#path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await writeFile(temporary, JSON.stringify(fileSchema.parse({ version: 1, records })), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
    this.#records = structuredClone(records);
  }
}

export class InMemoryCleanupRepairStore implements CleanupRepairStore {
  readonly #records = new Map<string, CleanupRepairRecord>();
  constructor(records: CleanupRepairRecord[] = []) { for (const record of records) this.#records.set(record.commandId, repairSchema.parse(record)); }
  async load(): Promise<CleanupRepairRecord[]> { return structuredClone([...this.#records.values()]); }
  async put(record: CleanupRepairRecord): Promise<void> { const parsed = repairSchema.parse(record); this.#records.set(parsed.commandId, parsed); }
  async remove(commandId: string): Promise<void> { this.#records.delete(commandId); }
}
