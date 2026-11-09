/**
 * Drizzle client over node-postgres (`pg`) with a connection pool.
 *
 * `setDb()` lets the self-contained simulation swap in an in-memory PGlite
 * database with the same schema and migrations; app code always calls `db()`.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { normalizeDatabaseUrl } from "./url";

export type Database = NodePgDatabase<typeof schema>;

const g = globalThis as unknown as { __trancheDb?: Database; __tranchePool?: Pool; __trancheDbOverride?: Database };

export function db(): Database {
  if (g.__trancheDbOverride) return g.__trancheDbOverride;
  if (!g.__trancheDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const pool = new Pool({
      connectionString: normalizeDatabaseUrl(url),
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
    });
    g.__tranchePool = pool;
    g.__trancheDb = drizzle(pool, { schema });
  }
  return g.__trancheDb;
}

export function setDb(database: Database): void {
  g.__trancheDbOverride = database;
}

export async function closeDb(): Promise<void> {
  await g.__tranchePool?.end();
  g.__tranchePool = undefined;
  g.__trancheDb = undefined;
}

export { schema };
