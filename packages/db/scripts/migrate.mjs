import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Pool } = pg;

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(packageRoot, "migrations");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://deploylite:deploylite@localhost:55433/deploylite";

const pool = new Pool({ connectionString: databaseUrl });

async function connectWithRetry(attempts = 20) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await pool.connect();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw lastError;
}

async function migrate() {
  const client = await connectWithRetry();

  try {
    await client.query("begin");
    await client.query(`
      create table if not exists __deploylite_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const existing = await client.query("select 1 from __deploylite_migrations where id = $1", [file]);
      if (existing.rowCount && existing.rowCount > 0) {
        continue;
      }

      const sql = await readFile(join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query("insert into __deploylite_migrations (id) values ($1)", [file]);
      console.log(`Applied ${file}`);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

migrate()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
