import { describe, expect, it } from "vitest";

import {
  createEnvSecretCipher,
  EnvSecretCipherError,
  EnvSecretKeyInvalidError,
  EnvSecretKeyMissingError,
  loadEnvSecretKey,
  loadEnvSecretKeyFromEnv,
  safeEqualFingerprint
} from "./crypto.js";

const validKey = "test_fixture_crypto_key_1234567890";

describe("env secret encryption", () => {
  it("derives a 32-byte key from a non-empty DEPLOYLITE_SECRET_KEY", () => {
    const key = loadEnvSecretKey(validKey);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it("refuses to start when DEPLOYLITE_SECRET_KEY is missing", () => {
    expect(() => loadEnvSecretKey(undefined)).toThrow(EnvSecretKeyMissingError);
    expect(() => loadEnvSecretKey(null)).toThrow(EnvSecretKeyMissingError);
    expect(() => loadEnvSecretKey("")).toThrow(EnvSecretKeyMissingError);
    expect(() => loadEnvSecretKey("   ")).toThrow(EnvSecretKeyMissingError);
  });

  it("refuses weak DEPLOYLITE_SECRET_KEY values", () => {
    expect(() => loadEnvSecretKey("short")).toThrow(EnvSecretKeyInvalidError);
    expect(() => loadEnvSecretKey("contains spaces only xxxxxxxxx")).toThrow(EnvSecretKeyInvalidError);
    expect(() => loadEnvSecretKey("contains\x00null\x00characters")).toThrow(EnvSecretKeyInvalidError);
  });

  it("reads DEPLOYLITE_SECRET_KEY from a process-env-like object", () => {
    expect(() => loadEnvSecretKeyFromEnv({})).toThrow(EnvSecretKeyMissingError);
    expect(loadEnvSecretKeyFromEnv({ DEPLOYLITE_SECRET_KEY: validKey }).length).toBe(32);
  });

  it("round-trips arbitrary plaintexts through encrypt/decrypt", () => {
    const cipher = createEnvSecretCipher(loadEnvSecretKey(validKey));
    const samples = [
      "short",
      "ghp_fixture_token_1234567890abcdef",
      JSON.stringify({ nested: { token: "dl_fixture_token_abcdef1234567890", scopes: ["deploy", "read"] } }),
      "with\nmulti\nlines\nand\ttabs"
    ];

    for (const sample of samples) {
      const ciphertext = cipher.encrypt(sample);
      expect(ciphertext).not.toContain(sample);
      expect(cipher.decrypt(ciphertext)).toBe(sample);
    }
  });

  it("produces a different ciphertext for the same plaintext across calls (random IV)", () => {
    const cipher = createEnvSecretCipher(loadEnvSecretKey(validKey));
    const first = cipher.encrypt("repeatable-plaintext");
    const second = cipher.encrypt("repeatable-plaintext");
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe("repeatable-plaintext");
    expect(cipher.decrypt(second)).toBe("repeatable-plaintext");
  });

  it("fails closed when the GCM auth tag does not verify", () => {
    const cipher = createEnvSecretCipher(loadEnvSecretKey(validKey));
    const ciphertext = cipher.encrypt("authenticate-me");
    const buffer = Buffer.from(ciphertext, "base64");
    buffer[buffer.length - 1] ^= 0x01;
    const tampered = buffer.toString("base64");
    expect(() => cipher.decrypt(tampered)).toThrow(EnvSecretCipherError);
  });

  it("refuses to encrypt or decrypt non-string or empty payloads", () => {
    const cipher = createEnvSecretCipher(loadEnvSecretKey(validKey));
    expect(() => cipher.encrypt("")).toThrow(EnvSecretCipherError);
    expect(() => cipher.decrypt("")).toThrow(EnvSecretCipherError);
    expect(() => cipher.decrypt("aGVsbG8=")).toThrow(EnvSecretCipherError);
  });

  it("rejects a cipher created with the wrong key buffer size", () => {
    expect(() => createEnvSecretCipher(Buffer.alloc(16))).toThrow(EnvSecretKeyInvalidError);
    expect(() => createEnvSecretCipher(Buffer.alloc(64))).toThrow(EnvSecretKeyInvalidError);
    expect(() => createEnvSecretCipher("not-a-buffer" as unknown as Buffer)).toThrow(EnvSecretKeyInvalidError);
  });

  it("computes a stable, keyed, fixed-length hex fingerprint per plaintext", () => {
    const cipher = createEnvSecretCipher(loadEnvSecretKey(validKey));
    const otherCipher = createEnvSecretCipher(loadEnvSecretKey("test_fixture_crypto_key_different_123456"));
    const left = cipher.fingerprint("api-token-1");
    const right = cipher.fingerprint("api-token-1");
    const other = cipher.fingerprint("api-token-2");

    expect(left).toBe(right);
    expect(left).not.toBe(other);
    expect(left).not.toBe(otherCipher.fingerprint("api-token-1"));
    expect(left).toMatch(/^[0-9a-f]{32}$/);
    expect(safeEqualFingerprint(left, right)).toBe(true);
    expect(safeEqualFingerprint(left, other)).toBe(false);
    expect(safeEqualFingerprint(left, left.slice(0, -1))).toBe(false);
  });

  it("never includes the raw plaintext in a serialized ciphertext envelope", () => {
    const cipher = createEnvSecretCipher(loadEnvSecretKey(validKey));
    const raw = "fixture_secret_raw_marker_42";
    const envelope = cipher.encrypt(raw);
    expect(envelope).not.toContain(raw);
    expect(envelope).not.toContain("raw_marker");
    expect(envelope).not.toContain("fixture_secret_");
  });
});
