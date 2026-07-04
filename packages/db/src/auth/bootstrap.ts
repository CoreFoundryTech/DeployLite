import type { AuthUserRepository, SafeAuthUser } from "@deploylite/domain";
import { toSafeAuthUser, type PasswordHasher } from "@deploylite/domain";

export type BootstrapInitialAdminInput = {
  email: string;
  password: string;
};

export async function bootstrapInitialAdmin(
  users: AuthUserRepository,
  hasher: PasswordHasher,
  input: BootstrapInitialAdminInput
): Promise<{ user: SafeAuthUser; created: boolean }> {
  const existing = await users.findByEmail(input.email);
  if (existing) {
    return { user: toSafeAuthUser(existing), created: false };
  }

  const passwordHash = await hasher.hash(input.password);
  const created = await users.createInitialAdmin({ email: input.email, passwordHash });
  return { user: toSafeAuthUser(created), created: true };
}
