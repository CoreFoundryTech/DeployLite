import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Fail-closed configuration for the env secret value encryption layer.
 *
 * `DEPLOYLITE_SECRET_KEY` is the only allowed source for the master key. The
 * helper deliberately refuses to start when the env var is missing or
 * obviously weak (less than 16 characters of non-whitespace input) so that
 * production cannot accidentally fall back to a hard-coded key. The resulting
 * 32-byte symmetric key is derived deterministically with SHA-256, which keeps
 * it stable across restarts while still providing a 256-bit AES-256-GCM key
 * even if the operator's input was a passphrase.
 */

const MIN_SECRET_KEY_LENGTH = 16;
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const FINGERPRINT_HEX_LENGTH = 32;

const SECRET_KEY_PATTERN = /^[A-Za-z0-9+/=._\-+/]+$/;

export class EnvSecretKeyMissingError extends Error {
  constructor(detail: string) {
    super(`DEPLOYLITE_SECRET_KEY is required for env secret encryption: ${detail}`);
    this.name = "EnvSecretKeyMissingError";
  }
}

export class EnvSecretKeyInvalidError extends Error {
  constructor(detail: string) {
    super(`DEPLOYLITE_SECRET_KEY is invalid for env secret encryption: ${detail}`);
    this.name = "EnvSecretKeyInvalidError";
  }
}

export class EnvSecretCipherError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(`Env secret encryption failed: ${detail}`);
    this.name = "EnvSecretCipherError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export type EnvSecretCipher = {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  fingerprint(plaintext: string): string;
};

export function loadEnvSecretKey(rawValue: string | undefined | null): Buffer {
  if (typeof rawValue !== "string") {
    throw new EnvSecretKeyMissingError("environment variable is not set");
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    throw new EnvSecretKeyMissingError("environment variable is empty");
  }
  if (trimmed.length < MIN_SECRET_KEY_LENGTH) {
    throw new EnvSecretKeyInvalidError(
      `expected at least ${MIN_SECRET_KEY_LENGTH} non-whitespace characters (got ${trimmed.length})`
    );
  }
  if (!SECRET_KEY_PATTERN.test(trimmed)) {
    throw new EnvSecretKeyInvalidError(
      "expected only printable ASCII characters [A-Z a-z 0-9 + / = . _ - + /]"
    );
  }
  return createHash("sha256").update(trimmed, "utf8").digest().subarray(0, KEY_LENGTH_BYTES);
}

/**
 * Read `DEPLOYLITE_SECRET_KEY` from the supplied env object and return a
 * 32-byte key buffer. Throws {@link EnvSecretKeyMissingError} or
 * {@link EnvSecretKeyInvalidError} when the value is missing or invalid.
 */
export function loadEnvSecretKeyFromEnv(env: NodeJS.ProcessEnv): Buffer {
  return loadEnvSecretKey(env.DEPLOYLITE_SECRET_KEY);
}

export function createEnvSecretCipher(key: Buffer): EnvSecretCipher {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH_BYTES) {
    throw new EnvSecretKeyInvalidError(
      `expected a 32-byte buffer (got ${Buffer.isBuffer(key) ? `${key.length} bytes` : typeof key})`
    );
  }

  const fingerprint = (plaintext: string): string => {
    if (typeof plaintext !== "string") {
      throw new EnvSecretCipherError("plaintext must be a string");
    }
    if (plaintext.length === 0) {
      throw new EnvSecretCipherError("plaintext must not be empty");
    }
    return createHash("sha256").update(plaintext, "utf8").digest("hex").slice(0, FINGERPRINT_HEX_LENGTH);
  };

  const encrypt = (plaintext: string): string => {
    if (typeof plaintext !== "string") {
      throw new EnvSecretCipherError("plaintext must be a string");
    }
    if (plaintext.length === 0) {
      throw new EnvSecretCipherError("plaintext must not be empty");
    }

    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
      throw new EnvSecretCipherError(`expected ${AUTH_TAG_LENGTH_BYTES}-byte GCM auth tag`);
    }
    return Buffer.concat([iv, encrypted, authTag]).toString("base64");
  };

  const decrypt = (payload: string): string => {
    if (typeof payload !== "string" || payload.length === 0) {
      throw new EnvSecretCipherError("ciphertext payload must be a non-empty string");
    }
    const buffer = Buffer.from(payload, "base64");
    if (buffer.length < IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES + 1) {
      throw new EnvSecretCipherError("ciphertext payload is shorter than the minimum envelope size");
    }
    const iv = buffer.subarray(0, IV_LENGTH_BYTES);
    const authTag = buffer.subarray(buffer.length - AUTH_TAG_LENGTH_BYTES);
    const encrypted = buffer.subarray(IV_LENGTH_BYTES, buffer.length - AUTH_TAG_LENGTH_BYTES);
    if (encrypted.length === 0) {
      throw new EnvSecretCipherError("ciphertext payload is missing the encrypted body");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    try {
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return plaintext.toString("utf8");
    } catch (cause) {
      throw new EnvSecretCipherError("authentication tag verification failed or ciphertext is corrupted", cause);
    }
  };

  return { encrypt, decrypt, fingerprint };
}

/**
 * Compare two env secret value fingerprints in constant time. The helpers in
 * this module always emit fixed-length hex strings, so the comparison is safe
 * to expose to other modules that may receive externally supplied digests.
 */
export function safeEqualFingerprint(expected: string, actual: string): boolean {
  if (typeof expected !== "string" || typeof actual !== "string") {
    return false;
  }
  if (expected.length === 0 || expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
}

export const ENCRYPTION_KEY_VERSION = 1;
export const FINGERPRINT_LENGTH = FINGERPRINT_HEX_LENGTH;
