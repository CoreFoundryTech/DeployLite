import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const MAX_ENTRIES = 256;
const MAX_FILE_BYTES = 64 * 1024;
const REGISTRY_VERSION = 2;
const KEY_VERSION = 1;
const commandId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const timestamp = z.string().datetime({ offset: true });
const entrySchema = z.object({ version: z.literal(1), commandId, builderName: z.string().regex(/^deploylite-[a-z0-9][a-z0-9-]{0,62}$/), registeredAt: timestamp, updatedAt: timestamp }).strict();
const unsignedFileSchema = z.object({ version: z.literal(REGISTRY_VERSION), keyVersion: z.literal(KEY_VERSION), entries: z.array(entrySchema).max(MAX_ENTRIES) }).strict();
const fileSchema = unsignedFileSchema.extend({ mac: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export type ManagedBuilderRecord = z.infer<typeof entrySchema>;
export type ManagedBuilderRegistry = { load(): Promise<ManagedBuilderRecord[]>; put(record: Omit<ManagedBuilderRecord, "registeredAt" | "updatedAt">): Promise<void>; remove(commandId: string): Promise<void> };

export class ManagedBuilderRegistryRecoveryError extends Error {
  constructor() { super("Managed builder registry recovery requires operator intervention"); this.name = "ManagedBuilderRegistryRecoveryError"; }
}

type VerifiedFile = { entries: ManagedBuilderRecord[]; payload: string };
type ReadResult = { state: "missing" } | { state: "valid"; file: VerifiedFile } | { state: "invalid" };

/** Authenticated, redundant ownership evidence for managed Buildx builders. */
export class FileManagedBuilderRegistry implements ManagedBuilderRegistry {
  readonly #path: string;
  readonly #backupPath: string;
  readonly #recoveryMarkerPath: string;
  readonly #integrityKey: Buffer;
  readonly #now: () => Date;
  #entries: ManagedBuilderRecord[] | null = null;

  constructor(path: string, integrityKey: string | Buffer, now: () => Date = () => new Date()) {
    if (!path.startsWith("/")) throw new Error("Managed builder registry path must be absolute");
    if (!integrityKey || integrityKey.length > 4096) throw new Error("Managed builder registry integrity key is required");
    this.#path = resolve(path);
    this.#backupPath = `${this.#path}.backup`;
    this.#recoveryMarkerPath = `${this.#path}.recovery-required`;
    this.#integrityKey = Buffer.from(integrityKey);
    this.#now = now;
  }

  async load(): Promise<ManagedBuilderRecord[]> {
    if (this.#entries) return structuredClone(this.#entries);
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const primary = await this.#readVerified(this.#path);
    if (primary.state === "valid") return this.#setEntries(primary.file.entries);

    const backup = await this.#readVerified(this.#backupPath);
    if (backup.state === "valid") {
      if (primary.state === "invalid") await this.#quarantinePrimary();
      await this.#writeVerified(this.#path, backup.file.payload);
      await rm(this.#recoveryMarkerPath, { force: true });
      return this.#setEntries(backup.file.entries);
    }

    if (primary.state === "missing" && backup.state === "missing") return this.#setEntries([]);
    if (primary.state === "invalid") await this.#quarantinePrimary();
    await this.#writeRecoveryMarker();
    throw new ManagedBuilderRegistryRecoveryError();
  }

  async put(record: Omit<ManagedBuilderRecord, "registeredAt" | "updatedAt">): Promise<void> {
    const parsed = z.object({ version: z.literal(1), commandId, builderName: z.string() }).strict().parse(record);
    if (parsed.builderName !== `deploylite-${parsed.commandId}`) throw new Error("Managed builder name does not match command id");
    const entries = await this.load();
    const previous = entries.find((entry) => entry.commandId === parsed.commandId);
    const now = this.#now().toISOString();
    const next = [...entries.filter((entry) => entry.commandId !== parsed.commandId), entrySchema.parse({ ...parsed, registeredAt: previous?.registeredAt ?? now, updatedAt: now })];
    if (next.length > MAX_ENTRIES) throw new Error("Managed builder registry is full");
    await this.#persist(next);
  }

  async remove(commandIdValue: string): Promise<void> {
    const parsed = commandId.parse(commandIdValue);
    const entries = await this.load();
    const next = entries.filter((entry) => entry.commandId !== parsed);
    if (next.length !== entries.length) await this.#persist(next);
  }

  async #persist(entries: ManagedBuilderRecord[]): Promise<void> {
    const primary = await this.#readVerified(this.#path);
    if (primary.state === "invalid") throw new ManagedBuilderRegistryRecoveryError();
    if (primary.state === "valid") await this.#writeVerified(this.#backupPath, primary.file.payload);
    const payload = this.#serialize(entries);
    await this.#writeVerified(this.#path, payload);
    if (primary.state === "missing") await this.#writeVerified(this.#backupPath, payload);
    await rm(this.#recoveryMarkerPath, { force: true });
    this.#entries = structuredClone(entries);
  }

  async #readVerified(path: string): Promise<ReadResult> {
    try {
      const contents = await readFile(path, "utf8");
      if (Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES) return { state: "invalid" };
      const parsed = fileSchema.safeParse(JSON.parse(contents));
      if (!parsed.success) return { state: "invalid" };
      const { mac, ...unsigned } = parsed.data;
      const canonical = canonicalize(unsigned);
      if (!constantTimeEqual(mac, this.#mac(canonical))) return { state: "invalid" };
      return { state: "valid", file: { entries: parsed.data.entries, payload: canonicalize(parsed.data) } };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "invalid" };
    }
  }

  #serialize(entries: ManagedBuilderRecord[]): string {
    const unsigned = unsignedFileSchema.parse({ version: REGISTRY_VERSION, keyVersion: KEY_VERSION, entries });
    return canonicalize({ ...unsigned, mac: this.#mac(canonicalize(unsigned)) });
  }

  #mac(canonical: string): string { return createHmac("sha256", this.#integrityKey).update(canonical, "utf8").digest("hex"); }
  #setEntries(entries: ManagedBuilderRecord[]): ManagedBuilderRecord[] { this.#entries = structuredClone(entries); return structuredClone(entries); }

  async #quarantinePrimary(): Promise<void> {
    const quarantine = `${this.#path}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
    try { await chmod(this.#path, 0o600); await rename(this.#path, quarantine); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ManagedBuilderRegistryRecoveryError(); }
  }

  async #writeRecoveryMarker(): Promise<void> { await this.#atomicWrite(this.#recoveryMarkerPath, "version=1\n"); }

  async #writeVerified(path: string, contents: string): Promise<void> {
    await this.#atomicWrite(path, contents);
    const verified = await this.#readVerified(path);
    if (verified.state !== "valid" || verified.file.payload !== contents) throw new ManagedBuilderRegistryRecoveryError();
  }

  async #atomicWrite(path: string, contents: string): Promise<void> {
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      await chmod(path, 0o600);
      await syncDirectory(dirname(path));
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function canonicalize(value: unknown): string { return JSON.stringify(value); }
function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex"); const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
async function syncDirectory(path: string): Promise<void> {
  try { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
  catch (error) { if (!(["EINVAL", "ENOTSUP", "EPERM"] as const).includes((error as NodeJS.ErrnoException).code as "EINVAL")) throw error; }
}

export class InMemoryManagedBuilderRegistry implements ManagedBuilderRegistry {
  readonly #entries = new Map<string, ManagedBuilderRecord>();
  readonly #now: () => Date;
  constructor(now: () => Date = () => new Date()) { this.#now = now; }
  async load(): Promise<ManagedBuilderRecord[]> { return structuredClone([...this.#entries.values()]); }
  async put(record: Omit<ManagedBuilderRecord, "registeredAt" | "updatedAt">): Promise<void> {
    const parsed = z.object({ version: z.literal(1), commandId, builderName: z.string() }).strict().parse(record);
    if (parsed.builderName !== `deploylite-${parsed.commandId}`) throw new Error("Managed builder name does not match command id");
    const now = this.#now().toISOString(); const previous = this.#entries.get(parsed.commandId);
    this.#entries.set(parsed.commandId, entrySchema.parse({ ...parsed, registeredAt: previous?.registeredAt ?? now, updatedAt: now }));
  }
  async remove(commandIdValue: string): Promise<void> { this.#entries.delete(commandId.parse(commandIdValue)); }
}
