import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  // Neon closes idle connections and suspends idle computes, and laptops sleep. Fail fast
  // (instead of hanging ~20s on a dead socket) and retire idle connections before they go stale.
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
});
// An error on an idle pooled client must not crash the process; the pool discards that client.
pool.on("error", (err) => console.error("pg pool idle client error:", err.message));
export const db = drizzle(pool, { schema });
export type Db = typeof db;

/**
 * Runs `fn` in a transaction with the RLS user variable set. Every user-scoped
 * query must go through this so Postgres policies enforce isolation.
 */
export async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // Drop to the limited role so RLS applies even if the login role bypasses it.
    await tx.execute(sql`set local role aimanager_app`);
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx as unknown as Db);
  });
}
