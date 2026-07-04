import { describe, expect, it } from "vitest";
import { InitialAdminAlreadyExistsError, type AuthUser, type AuthUserRepository } from "@deploylite/domain";

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
  it("locks bootstrap when any user already exists", async () => {
    const repo: AuthUserRepository = {
      async findByEmail() {
        return null;
      },
      async findById() {
        return existingAdmin;
      },
      async count() {
        return 1;
      },
      async createInitialAdmin() {
        throw new Error("should not create duplicate admin");
      }
    };

    const result = await bootstrapInitialAdmin(repo, { hash: async () => "new-hash", verify: async () => true }, { email: existingAdmin.email, password: "unused" });

    expect(result.created).toBe(false);
    expect(result.user).toBeNull();
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
      async count() {
        return 0;
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

  it("maps an atomic repository bootstrap conflict to locked", async () => {
    const repo: AuthUserRepository = {
      async findByEmail() {
        return null;
      },
      async findById() {
        return null;
      },
      async count() {
        return 0;
      },
      async createInitialAdmin() {
        throw new InitialAdminAlreadyExistsError();
      }
    };

    const result = await bootstrapInitialAdmin(repo, { hash: async () => "hashed-password", verify: async () => true }, { email: "race@example.test", password: "plain-password" });

    expect(result).toEqual({ user: null, created: false });
  });
});
