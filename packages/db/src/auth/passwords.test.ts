import { describe, expect, it } from "vitest";

import { BcryptPasswordHasher } from "./passwords.js";

describe("BcryptPasswordHasher", () => {
  it("hashes and verifies valid passwords without preserving plaintext", async () => {
    const hasher = new BcryptPasswordHasher(10);
    const password = "correct horse battery staple";

    const hash = await hasher.hash(password);

    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(hash).not.toContain(password);
    await expect(hasher.verify(password, hash)).resolves.toBe(true);
  });

  it("rejects invalid passwords and malformed hashes", async () => {
    const hasher = new BcryptPasswordHasher(10);
    const hash = await hasher.hash("correct horse battery staple");

    await expect(hasher.verify("wrong horse battery staple", hash)).resolves.toBe(false);
    await expect(hasher.verify("correct horse battery staple", "plaintext")).resolves.toBe(false);
    await expect(hasher.hash("short")).rejects.toThrow("at least 12 characters");
  });
});
