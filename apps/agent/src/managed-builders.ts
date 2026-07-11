import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const MAX_ENTRIES = 256;
const MAX_FILE_BYTES = 64 * 1024;
const REGISTRY_VERSION = 3;
const KEY_VERSION = 1;
const MIN_INTEGRITY_KEY_BYTES = 32;
const commandId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const timestamp = z.string().datetime({ offset: true });
const entrySchema = z.object({ version: z.literal(1), commandId, builderName: z.string().regex(/^deploylite-[a-z0-9][a-z0-9-]{0,62}$/), registeredAt: timestamp, updatedAt: timestamp }).strict();
const unsignedFileSchema = z.object({ version: z.literal(REGISTRY_VERSION), keyVersion: z.literal(KEY_VERSION), generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), entries: z.array(entrySchema).max(MAX_ENTRIES) }).strict();
const fileSchema = unsignedFileSchema.extend({ mac: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export type ManagedBuilderRecord = z.infer<typeof entrySchema>;
export type ManagedBuilderRegistry = { load(): Promise<ManagedBuilderRecord[]>; put(record: Omit<ManagedBuilderRecord, "registeredAt" | "updatedAt">): Promise<void>; remove(commandId: string): Promise<void> };

export class ManagedBuilderRegistryRecoveryError extends Error {
  constructor() { super("Managed builder registry recovery requires operator intervention"); this.name = "ManagedBuilderRegistryRecoveryError"; }
}

type VerifiedFile = { entries: ManagedBuilderRecord[]; generation: number; payload: string; signedBy: "current" | "previous" };
type ReadResult = { state: "missing" } | { state: "valid"; file: VerifiedFile } | { state: "invalid" };
type MarkerState = "missing" | "valid" | "invalid";
type WriteObserver = (path: string) => void | Promise<void>;

/** Authenticated, redundant ownership evidence for managed Buildx builders. */
export class FileManagedBuilderRegistry implements ManagedBuilderRegistry {
  readonly #path: string;
  readonly #backupPath: string;
  readonly #recoveryMarkerPath: string;
  readonly #integrityKey: Buffer;
  readonly #previousIntegrityKey: Buffer | null;
  readonly #now: () => Date;
  readonly #afterWrite: WriteObserver | undefined;
  #entries: ManagedBuilderRecord[] | null = null;
  #generation: number | null = null;

  constructor(path: string, integrityKey: string | Buffer, now: () => Date = () => new Date(), previousIntegrityKey?: string | Buffer, afterWrite?: WriteObserver) {
    if (!path.startsWith("/")) throw new Error("Managed builder registry path must be absolute");
    this.#integrityKey = requiredIntegrityKey(integrityKey);
    this.#previousIntegrityKey = previousIntegrityKey ? requiredIntegrityKey(previousIntegrityKey) : null;
    if (this.#previousIntegrityKey?.equals(this.#integrityKey)) throw new Error("Managed builder registry previous integrity key must differ from current key");
    this.#path = resolve(path);
    this.#backupPath = `${this.#path}.backup`;
    this.#recoveryMarkerPath = `${this.#path}.recovery-required`;
    this.#now = now;
    this.#afterWrite = afterWrite;
  }

  async load(): Promise<ManagedBuilderRecord[]> {
    if (this.#entries) return structuredClone(this.#entries);
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const marker = await this.#readRecoveryMarker();
    if (marker === "invalid") throw new ManagedBuilderRegistryRecoveryError();
    const primary = await this.#readVerified(this.#path);
    const backup = await this.#readVerified(this.#backupPath);

    if (primary.state === "missing" && backup.state === "missing") {
      if (marker === "valid") throw new ManagedBuilderRegistryRecoveryError();
      return this.#setEntries([], 0);
    }
    if (primary.state !== "valid" && backup.state !== "valid") {
      if (primary.state === "invalid") await this.#quarantinePrimary();
      await this.#writeRecoveryMarker();
      throw new ManagedBuilderRegistryRecoveryError();
    }

    const authoritative = this.#authoritative(primary, backup);
    if (!authoritative) {
      await this.#writeRecoveryMarker();
      throw new ManagedBuilderRegistryRecoveryError();
    }
    await this.#restore(authoritative, primary, backup, marker === "valid");
    if (marker === "valid") await rm(this.#recoveryMarkerPath, { force: true });
    return this.#setEntries(authoritative.entries, authoritative.generation);
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
    const generation = (this.#generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new ManagedBuilderRegistryRecoveryError();
    const payload = this.#serialize(entries, generation);
    // Write the backup first: a crash after either replacement leaves a latest valid copy.
    await this.#writeVerified(this.#backupPath, payload);
    await this.#writeVerified(this.#path, payload);
    await rm(this.#recoveryMarkerPath, { force: true });
    this.#entries = structuredClone(entries);
    this.#generation = generation;
  }

  #authoritative(primary: ReadResult, backup: ReadResult): VerifiedFile | null {
    if (primary.state === "valid" && backup.state === "valid") {
      if (primary.file.generation !== backup.file.generation) return primary.file.generation > backup.file.generation ? primary.file : backup.file;
      if (canonicalize(primary.file.entries) !== canonicalize(backup.file.entries)) return null;
      return primary.file.signedBy === "current" ? primary.file : backup.file;
    }
    return primary.state === "valid" ? primary.file : backup.state === "valid" ? backup.file : null;
  }

  async #restore(authoritative: VerifiedFile, primary: ReadResult, backup: ReadResult, force: boolean): Promise<void> {
    const payload = this.#serialize(authoritative.entries, authoritative.generation);
    if (force || backup.state !== "valid" || backup.file.payload !== payload) await this.#writeVerified(this.#backupPath, payload);
    if (force || primary.state !== "valid" || primary.file.payload !== payload) await this.#writeVerified(this.#path, payload);
  }

  async #readVerified(path: string): Promise<ReadResult> {
    try {
      const contents = await readFile(path, "utf8");
      if (Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES) return { state: "invalid" };
      const parsed = fileSchema.safeParse(JSON.parse(contents));
      if (!parsed.success) return { state: "invalid" };
      const { mac, ...unsigned } = parsed.data;
      const canonical = canonicalize(unsigned);
      const signedBy = constantTimeEqual(mac, this.#mac(canonical, this.#integrityKey))
        ? "current"
        : this.#previousIntegrityKey && constantTimeEqual(mac, this.#mac(canonical, this.#previousIntegrityKey)) ? "previous" : null;
      if (!signedBy) return { state: "invalid" };
      return { state: "valid", file: { entries: parsed.data.entries, generation: parsed.data.generation, payload: canonicalize(parsed.data), signedBy } };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "invalid" };
    }
  }

  async #readRecoveryMarker(): Promise<MarkerState> {
    try {
      const contents = await readFile(this.#recoveryMarkerPath, "utf8");
      return Buffer.byteLength(contents, "utf8") <= 64 && contents === "version=1\n" ? "valid" : "invalid";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
    }
  }

  #serialize(entries: ManagedBuilderRecord[], generation: number): string {
    const unsigned = unsignedFileSchema.parse({ version: REGISTRY_VERSION, keyVersion: KEY_VERSION, generation, entries });
    return canonicalize({ ...unsigned, mac: this.#mac(canonicalize(unsigned), this.#integrityKey) });
  }

  #mac(canonical: string, key: Buffer): string { return createHmac("sha256", key).update(canonical, "utf8").digest("hex"); }
  #setEntries(entries: ManagedBuilderRecord[], generation: number): ManagedBuilderRecord[] { this.#entries = structuredClone(entries); this.#generation = generation; return structuredClone(entries); }

  async #quarantinePrimary(): Promise<void> {
    const quarantine = `${this.#path}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
    try { await chmod(this.#path, 0o600); await rename(this.#path, quarantine); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ManagedBuilderRegistryRecoveryError(); }
  }

  async #writeRecoveryMarker(): Promise<void> { await this.#atomicWrite(this.#recoveryMarkerPath, "version=1\n"); }

  async #writeVerified(path: string, contents: string): Promise<void> {
    await this.#atomicWrite(path, contents);
    const verified = await this.#readVerified(path);
    if (verified.state !== "valid" || verified.file.payload !== contents || verified.file.signedBy !== "current") throw new ManagedBuilderRegistryRecoveryError();
    await this.#afterWrite?.(path);
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

function requiredIntegrityKey(value: string | Buffer): Buffer {
  const key = Buffer.from(value);
  if (key.length < MIN_INTEGRITY_KEY_BYTES || key.length > 4096) throw new Error("Managed builder registry integrity key must be between 32 and 4096 bytes");
  return key;
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
