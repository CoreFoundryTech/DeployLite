import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const MAX_ENTRIES = 256;
const MAX_FILE_BYTES = 64 * 1024;
const commandId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const entrySchema = z.object({ version: z.literal(1), commandId, builderName: z.string().regex(/^deploylite-[a-z0-9][a-z0-9-]{0,62}$/) }).strict();
const fileSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(MAX_ENTRIES) }).strict();

export type ManagedBuilderRecord = z.infer<typeof entrySchema>;
export type ManagedBuilderRegistry = { load(): Promise<ManagedBuilderRecord[]>; put(record: ManagedBuilderRecord): Promise<void>; remove(commandId: string): Promise<void> };

export class FileManagedBuilderRegistry implements ManagedBuilderRegistry {
  readonly #path: string;
  #entries: ManagedBuilderRecord[] | null = null;
  constructor(path: string) { if (!path.startsWith("/")) throw new Error("Managed builder registry path must be absolute"); this.#path = resolve(path); }
  async load(): Promise<ManagedBuilderRecord[]> {
    if (this.#entries) return structuredClone(this.#entries);
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      const contents = await readFile(this.#path, "utf8");
      if (Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES) throw new Error("managed builder registry exceeds size limit");
      this.#entries = fileSchema.parse(JSON.parse(contents)).entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.#entries = []; return []; }
      const quarantine = `${this.#path}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
      try { await chmod(this.#path, 0o600); await rename(this.#path, quarantine); this.#entries = []; await this.#persist([]); }
      catch { throw new Error("Managed builder registry is corrupt and could not be quarantined"); }
    }
    return structuredClone(this.#entries);
  }
  async put(record: ManagedBuilderRecord): Promise<void> {
    const parsed = entrySchema.parse(record);
    if (parsed.builderName !== `deploylite-${parsed.commandId}`) throw new Error("Managed builder name does not match command id");
    const entries = await this.load();
    const next = [...entries.filter((entry) => entry.commandId !== parsed.commandId), parsed];
    if (next.length > MAX_ENTRIES) throw new Error("Managed builder registry is full");
    await this.#persist(next);
  }
  async remove(commandIdValue: string): Promise<void> {
    const parsed = commandId.parse(commandIdValue);
    const entries = await this.load(); const next = entries.filter((entry) => entry.commandId !== parsed);
    if (next.length !== entries.length) await this.#persist(next);
  }
  async #persist(entries: ManagedBuilderRecord[]): Promise<void> {
    const temporary = `${this.#path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await writeFile(temporary, JSON.stringify(fileSchema.parse({ version: 1, entries })), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.#path); await chmod(this.#path, 0o600); this.#entries = structuredClone(entries);
  }
}

export class InMemoryManagedBuilderRegistry implements ManagedBuilderRegistry {
  readonly #entries = new Map<string, ManagedBuilderRecord>();
  async load(): Promise<ManagedBuilderRecord[]> { return structuredClone([...this.#entries.values()]); }
  async put(record: ManagedBuilderRecord): Promise<void> { const parsed = entrySchema.parse(record); if (parsed.builderName !== `deploylite-${parsed.commandId}`) throw new Error("Managed builder name does not match command id"); this.#entries.set(parsed.commandId, parsed); }
  async remove(commandId: string): Promise<void> { this.#entries.delete(commandId); }
}
