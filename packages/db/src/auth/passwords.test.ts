import { describe, expect, it } from "vitest";

import { BcryptPasswordHasher } from "./passwords.js";

describe("BcryptPasswordHasher", () => {
  it("hashes and verifies valid passwords without preserving plaintext", async () => {
    const hasher = new BcryptPasswordHasher(10);
    const password = "test_fixture_password_primary";

    const hash = await hasher.hash(password);

    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(hash).not.toContain(password);
    await expect(hasher.verify(password, hash)).resolves.toBe(true);
  });

  it("rejects invalid passwords and malformed hashes", async () => {
    const hasher = new BcryptPasswordHasher(10);
    const hash = await hasher.hash("test_fixture_password_primary");

    await expect(hasher.verify("test_fixture_password_wrong", hash)).resolves.toBe(false);
    await expect(hasher.verify("test_fixture_password_primary", "fixture_plaintext_hash")).resolves.toBe(false);
    await expect(hasher.hash("short")).rejects.toThrow("at least 12 characters");
  });
});
