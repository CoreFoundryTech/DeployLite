import bcrypt from "bcryptjs";

const DEFAULT_COST = 12;

export class BcryptPasswordHasher {
  constructor(private readonly cost = DEFAULT_COST) {
    if (!Number.isInteger(cost) || cost < 10 || cost > 14) {
      throw new Error("bcrypt cost must be an integer between 10 and 14");
    }
  }

  async hash(password: string): Promise<string> {
    assertPassword(password);
    return bcrypt.hash(password, this.cost);
  }

  async verify(password: string, hash: string): Promise<boolean> {
    if (!password || !hash || !hash.startsWith("$2")) {
      return false;
    }

    return bcrypt.compare(password, hash);
  }
}

function assertPassword(password: string): void {
  if (password.length < 12) {
    throw new Error("Password must contain at least 12 characters");
  }
}
