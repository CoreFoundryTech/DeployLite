import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { CleanupRepairRecord, CleanupRepairStore } from "./executor/index.js";

const MAX_RECORDS = 256;
const MAX_FILE_BYTES = 256 * 1024;
const repairSchema = z.object({
  version: z.literal(1),
  commandId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  projectSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
}).strict();
const fileSchema = z.object({ version: z.literal(1), records: z.array(repairSchema).max(MAX_RECORDS), recoveryPending: z.boolean().optional(), recoveryCursor: z.number().int().min(0).optional(), recoveryOverflowReason: z.string().max(256).optional() }).strict();

export class CorruptCleanupRepairStoreError extends Error {
  constructor() {
    super("Cleanup repair state is corrupt and could not be quarantined");
    this.name = "CorruptCleanupRepairStoreError";
  }
}

export class FileCleanupRepairStore implements CleanupRepairStore {
  readonly #path: string;
  #records: CleanupRepairRecord[] | null = null;
  #recoveryPending = false;
  #recoveryCursor = 0;
  #recoveryOverflowReason: string | undefined;

  constructor(path: string) {
    if (!path.startsWith("/")) throw new Error("Cleanup repair path must be absolute");
    this.#path = resolve(path);
  }

  async load(): Promise<CleanupRepairRecord[]> {
    if (this.#records) return structuredClone(this.#records);
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      const contents = await readFile(this.#path, "utf8");
      if (Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES) throw new Error("cleanup repair state exceeds size limit");
      const parsed = fileSchema.parse(JSON.parse(contents));
      this.#records = parsed.records;
      this.#recoveryPending = parsed.recoveryPending === true;
      this.#recoveryCursor = parsed.recoveryCursor ?? 0;
      this.#recoveryOverflowReason = parsed.recoveryOverflowReason;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#records = [];
        return [];
      }
      const quarantinePath = `${this.#path}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
      try {
        await chmod(this.#path, 0o600);
        await rename(this.#path, quarantinePath);
      } catch {
        throw new CorruptCleanupRepairStoreError();
      }
      this.#records = [];
      this.#recoveryPending = true;
      try { await this.#persist([]); }
      catch { throw new CorruptCleanupRepairStoreError(); }
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

  async recoveryRequired(): Promise<boolean> {
    await this.load();
    return this.#recoveryPending;
  }

  async recoveryProgress(): Promise<{ cursor: number; overflowReason?: string }> {
    await this.load();
    return { cursor: this.#recoveryCursor, overflowReason: this.#recoveryOverflowReason };
  }

  async persistRecoveryPage(records: CleanupRepairRecord[], cursor: number, overflowReason?: string): Promise<void> {
    await this.load();
    if (!this.#recoveryPending) throw new Error("Cleanup recovery is not pending");
    const next = new Map(this.#records!.map((record) => [record.commandId, record]));
    for (const record of records) next.set(record.commandId, repairSchema.parse(record));
    if (next.size > MAX_RECORDS) throw new Error("Cleanup repair state is full");
    const previousCursor = this.#recoveryCursor;
    const previousOverflow = this.#recoveryOverflowReason;
    this.#recoveryCursor = cursor;
    this.#recoveryOverflowReason = overflowReason;
    try { await this.#persist([...next.values()]); }
    catch (error) { this.#recoveryCursor = previousCursor; this.#recoveryOverflowReason = previousOverflow; throw error; }
  }

  async completeRecovery(records: CleanupRepairRecord[]): Promise<void> {
    await this.load();
    const deduped = [...new Map(records.map((record) => {
      const parsed = repairSchema.parse(record);
      return [parsed.commandId, parsed] as const;
    })).values()];
    if (deduped.length > MAX_RECORDS) throw new Error("Cleanup repair state is full");
    const pending = this.#recoveryPending;
    const cursor = this.#recoveryCursor;
    const overflowReason = this.#recoveryOverflowReason;
    this.#recoveryPending = false;
    this.#recoveryCursor = 0;
    this.#recoveryOverflowReason = undefined;
    try { await this.#persist(deduped); }
    catch (error) { this.#recoveryPending = pending; this.#recoveryCursor = cursor; this.#recoveryOverflowReason = overflowReason; throw error; }
  }

  async #persist(records: CleanupRepairRecord[]): Promise<void> {
    const temporary = `${this.#path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await writeFile(temporary, JSON.stringify(fileSchema.parse({ version: 1, records, recoveryPending: this.#recoveryPending || undefined, recoveryCursor: this.#recoveryCursor || undefined, recoveryOverflowReason: this.#recoveryOverflowReason })), { encoding: "utf8", mode: 0o600, flag: "wx" });
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
  async recoveryRequired(): Promise<boolean> { return false; }
  async recoveryProgress(): Promise<{ cursor: number; overflowReason?: string }> { return { cursor: 0 }; }
  async persistRecoveryPage(records: CleanupRepairRecord[]): Promise<void> { for (const record of records) await this.put(record); }
  async completeRecovery(records: CleanupRepairRecord[]): Promise<void> { for (const record of records) await this.put(record); }
}
