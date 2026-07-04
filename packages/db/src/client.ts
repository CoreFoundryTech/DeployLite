import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema.js";

export function createDbPool(connectionString: string, options: Omit<PoolConfig, "connectionString"> = {}) {
  return new Pool({ connectionString, ...options });
}

export function createDbClient(pool: Pool) {
  return drizzle(pool, { schema });
}

export type DeployLiteDb = ReturnType<typeof createDbClient>;

export async function closeDbPool(pool: Pool): Promise<void> {
  await pool.end();
}
