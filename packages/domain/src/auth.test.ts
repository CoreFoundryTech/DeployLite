import { describe, expect, it } from "vitest";

import { authenticateLocalUser, type AuthUser, type AuthUserRepository, type PasswordHasher } from "./index.js";

const activeUser: AuthUser = {
  id: "user-1",
  email: "admin@example.test",
  emailNormalized: "admin@example.test",
  passwordHash: "stored-hash",
  role: "admin",
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z")
};

function users(user: AuthUser | null): AuthUserRepository {
  return {
    async findByEmail() {
      return user;
    },
    async findById() {
      return user;
    },
    async count() {
      return user ? 1 : 0;
    },
    async createInitialAdmin() {
      throw new Error("not used");
    }
  };
}

function hasher(matches: boolean): PasswordHasher {
  return {
    async hash() {
      return "stored-hash";
    },
    async verify() {
      return matches;
    }
  };
}

describe("authenticateLocalUser", () => {
  it("returns API-safe user metadata for valid active users", async () => {
    const result = await authenticateLocalUser(users(activeUser), hasher(true), "admin@example.test", "valid-password");

    expect(result).toEqual({
      id: activeUser.id,
      email: activeUser.email,
      emailNormalized: activeUser.emailNormalized,
      role: activeUser.role,
      status: activeUser.status,
      createdAt: activeUser.createdAt,
      updatedAt: activeUser.updatedAt
    });
    expect(result).not.toHaveProperty("passwordHash");
  });

  it("rejects invalid passwords", async () => {
    await expect(authenticateLocalUser(users(activeUser), hasher(false), "admin@example.test", "wrong-password")).resolves.toBeNull();
  });

  it("rejects disabled users before restoring identity", async () => {
    await expect(
      authenticateLocalUser(users({ ...activeUser, status: "disabled" }), hasher(true), "admin@example.test", "valid-password")
    ).resolves.toBeNull();
  });

  it("rejects unsupported persisted roles", async () => {
    await expect(
      authenticateLocalUser(users({ ...activeUser, role: "owner" as "admin" }), hasher(true), "admin@example.test", "valid-password")
    ).rejects.toThrow("Unsupported canonical role");
  });
});

describe("getBootstrapStatus", () => {
  it("reports setup required when no users exist", async () => {
    const { getBootstrapStatus } = await import("./index.js");

    await expect(getBootstrapStatus(users(null))).resolves.toEqual({ setupRequired: true });
  });

  it("locks setup when users already exist", async () => {
    const { getBootstrapStatus } = await import("./index.js");

    await expect(getBootstrapStatus(users(activeUser))).resolves.toEqual({ setupRequired: false });
  });
});
