import type { AuthUserRepository, SafeAuthUser } from "@deploylite/domain";
import { InitialAdminAlreadyExistsError, toSafeAuthUser, type PasswordHasher } from "@deploylite/domain";

export type BootstrapInitialAdminInput = {
  email: string;
  password: string;
};

export async function bootstrapInitialAdmin(users: AuthUserRepository, hasher: PasswordHasher, input: BootstrapInitialAdminInput): Promise<{ user: SafeAuthUser | null; created: boolean }> {
  if ((await users.count()) > 0) {
    return { user: null, created: false };
  }

  const passwordHash = await hasher.hash(input.password);
  try {
    const created = await users.createInitialAdmin({ email: input.email, passwordHash });
    return { user: toSafeAuthUser(created), created: true };
  } catch (error) {
    if (error instanceof InitialAdminAlreadyExistsError) {
      return { user: null, created: false };
    }
    throw error;
  }
}
