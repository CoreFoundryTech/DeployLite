import { describe, expect, it } from "vitest";
import type { AuthUser, AuthUserRepository } from "@deploylite/domain";

import { bootstrapInitialAdmin } from "./bootstrap.js";

const existingAdmin: AuthUser = {
  id: "user-1",
  email: "admin@example.test",
  emailNormalized: "admin@example.test",
  passwordHash: "stored-hash",
  role: "admin",
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z")
};

describe("bootstrapInitialAdmin", () => {
  it("is idempotent when the admin email already exists", async () => {
    const repo: AuthUserRepository = {
      async findByEmail() {
        return existingAdmin;
      },
      async findById() {
        return existingAdmin;
      },
      async createInitialAdmin() {
        throw new Error("should not create duplicate admin");
      }
    };

    const result = await bootstrapInitialAdmin(repo, { hash: async () => "new-hash", verify: async () => true }, { email: existingAdmin.email, password: "unused" });

    expect(result.created).toBe(false);
    expect(result.user).not.toHaveProperty("passwordHash");
  });

  it("creates a first admin with a hashed password", async () => {
    let createdWithHash: string | null = null;
    const repo: AuthUserRepository = {
      async findByEmail() {
        return null;
      },
      async findById() {
        return null;
      },
      async createInitialAdmin(input) {
        createdWithHash = input.passwordHash;
        return { ...existingAdmin, email: input.email, emailNormalized: input.email.toLowerCase(), passwordHash: input.passwordHash };
      }
    };

    const result = await bootstrapInitialAdmin(repo, { hash: async () => "hashed-password", verify: async () => true }, { email: "new@example.test", password: "plain-password" });

    expect(createdWithHash).toBe("hashed-password");
    expect(result).toMatchObject({ created: true, user: { email: "new@example.test", role: "admin" } });
    expect(result.user).not.toHaveProperty("passwordHash");
  });
});
